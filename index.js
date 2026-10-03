// dsh-flutter-panel — host half (Cordis plugin).
//
// Serves the Flutter panel page and its JSON API on the DSH web server. Two
// long-lived children back it: `flutter daemon` (devices, emulators, the
// DevTools server) and `flutter-devtools-mcp` (VM Service work). No dependency
// on any DSH internal package: routes come from ctx.webServer.
import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const name = 'dsh-flutter-panel'

/** The DSH web server is the only service this half needs. */
export const inject = ['webServer']

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MCP_PACKAGE = 'flutter-devtools-mcp'
const MCP_CALL_TIMEOUT_MS = 10 * 60 * 1000
const DAEMON_REQUEST_TIMEOUT_MS = 20 * 1000
const DAEMON_CONNECT_TIMEOUT_MS = 15 * 1000
const DEVICES_TIMEOUT_MS = 90 * 1000

/** Tools the panel may invoke; anything else is refused before it reaches the child. */
const ALLOWED_TOOLS = new Set([
  'discover_apps', 'connect', 'disconnect', 'get_app_info',
  'get_widget_tree', 'inspect_widget',
  'start_profiling', 'stop_profiling',
  'get_memory_snapshot', 'save_snapshot', 'compare_snapshots', 'list_snapshots',
  'start_tracking_rebuilds', 'stop_tracking_rebuilds',
  'start_network_capture', 'stop_network_capture',
  'hot_reload', 'hot_restart', 'take_screenshot', 'toggle_debug_paint',
  'evaluate_expression', 'collect_performance_session',
])

/**
 * One-shot project commands the panel may run. Each is the plain Flutter CLI
 * invoked with a fixed argv (no shell), so nothing user-supplied reaches a
 * command line.
 */
/**
 * Command output can be long, and `pub outdated` is a table whose header is at
 * the very top — clipping the tail instead of the head would leave the panel
 * with unparseable rows.
 */
function clipText(text, limit = 24000) {
  if (text.length <= limit) return text
  const head = text.slice(0, limit - 4000)
  const tail = text.slice(-4000)
  return `${head}\n… (output clipped, ${text.length - limit} characters omitted) …\n${tail}`
}

const PROJECT_COMMANDS = {
  pub_get: { label: 'pub get', args: ['pub', 'get'], timeoutMs: 180000 },
  pub_outdated: { label: 'pub outdated', args: ['pub', 'outdated'], timeoutMs: 240000 },
  doctor: { label: 'flutter doctor', args: ['doctor'], timeoutMs: 240000 },
}

/**
 * Debug toggles the panel exposes. Names and parameter shapes are taken from
 * the Flutter framework's own registrations (`registersBoolServiceExtension`
 * reads `enabled`, the numeric and string variants read `value`; an unknown
 * value clears `brightnessOverride`).
 */
const EXTENSIONS = {
  'ext.flutter.debugPaint': { label: 'Debug paint', kind: 'bool' },
  'ext.flutter.showPerformanceOverlay': { label: 'Performance overlay', kind: 'bool' },
  'ext.flutter.repaintRainbow': { label: 'Repaint rainbow', kind: 'bool' },
  'ext.flutter.debugPaintBaselinesEnabled': { label: 'Paint baselines', kind: 'bool' },
  'ext.flutter.timeDilation': { label: 'Slow animations', kind: 'value', on: 5.0, off: 1.0 },
  // brightnessOverride is deliberately absent: it reports the platform's
  // effective brightness, so "cleared" still reads as dark on a dark system and
  // the switch would lie about what it just did.
  'ext.flutter.inspector.show': { label: 'Widget selection', kind: 'bool' },
}

/** DevTools pages the panel can open; ids match DevTools' own routes. */
const DEVTOOLS_PAGES = ['inspector', 'performance', 'cpu-profiler', 'memory', 'network', 'logging']

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    return candidate
  }
  return candidates[candidates.length - 1]
}

// The Electron host may be launched from Finder, where PATH is only
// /usr/bin:/bin:/usr/sbin:/sbin — node/npx/flutter live in Homebrew.
function childEnv() {
  const path = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter(Boolean)
    .join(':')
  return { ...process.env, PATH: path }
}

const NPX = firstExisting(['/opt/homebrew/bin/npx', '/usr/local/bin/npx', 'npx'])

/**
 * Pids of `flutter_tools.snapshot run` processes under one root pid. `app.detach`
 * releases the app but the tool keeps running, and a plain group kill would take
 * the app down with it — so the tool is targeted by its own command line.
 */
function toolPidsUnder(rootPid) {
  let output = ''
  try {
    output = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const children = new Map()
  const commands = new Map()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (match === null) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    commands.set(pid, match[3])
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const found = []
  const walk = (pid) => {
    for (const childPid of children.get(pid) ?? []) {
      if (/flutter_tools\.snapshot run/.test(commands.get(childPid) ?? '')) found.push(childPid)
      walk(childPid)
    }
  }
  walk(rootPid)
  return found
}

/**
 * Kills a child and its descendants. `flutter` and `npx` are wrappers: the real
 * work happens in a grandchild (dartvm, the MCP server), so killing only the
 * direct child leaves it running — that is how an orphaned `flutter daemon`
 * survived earlier. Children are spawned detached so they lead their own
 * process group and the whole group can be dropped at once.
 */
function killTree(child) {
  if (child === null || child.killed === true) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // not a group leader (already gone, or the group was reaped)
  }
  child.kill()
}

/** The workspace's Flutter SDK: its own fvm pin first, then the machine's. */
async function resolveFlutter(cwd) {
  const candidates = []
  if (typeof cwd === 'string' && cwd !== '') {
    candidates.push(join(cwd, '.fvm', 'flutter_sdk', 'bin', 'flutter'))
    const pin = await fvmPin(cwd)
    if (pin !== null) {
      const roots = [
        process.env.DSH_FVM_ROOT,
        join(homedir(), 'fvm'),
        join(homedir(), 'DeveloperLibrary', 'fvm'),
        join(homedir(), '.fvm'),
      ].filter((root) => typeof root === 'string' && root !== '')
      for (const root of roots) candidates.push(join(root, 'versions', pin.version, 'bin', 'flutter'))
    }
  }
  candidates.push('/opt/homebrew/bin/flutter', '/usr/local/bin/flutter', 'flutter')
  return firstExisting(candidates)
}

/**
 * Flavors the project declares, best effort: Android `productFlavors` blocks and
 * Xcode scheme names that are not the default app or a test scheme. The panel
 * offers them as suggestions — the field stays free-form, because a flavor can
 * also live in a build script this does not read.
 */
async function discoverFlavors(cwd) {
  const found = new Map()
  if (typeof cwd !== 'string' || cwd === '') return []
  const readIfExists = async (rel) => {
    try {
      return await readFile(join(cwd, rel), 'utf8')
    } catch {
      return null
    }
  }
  for (const rel of ['android/app/build.gradle.kts', 'android/app/build.gradle']) {
    const text = await readIfExists(rel)
    if (text === null) continue
    const block = text.match(/productFlavors\s*\{([\s\S]*?)\n\s*\}/)
    if (block === null) continue
    for (const match of block[1].matchAll(/^\s*(?:create\(")?([A-Za-z][A-Za-z0-9_]*)"?\)?\s*(?:\{|$)/gm)) {
      const name = match[1]
      if (['create', 'dimension', 'getByName', 'register'].includes(name)) continue
      found.set(name, 'android')
    }
  }
  for (const platform of ['ios', 'macos']) {
    let entries = []
    try {
      entries = await readdir(join(cwd, `${platform}/Runner.xcodeproj/xcshareddata/xcschemes`))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.xcscheme')) continue
      const name = entry.replace(/\.xcscheme$/, '')
      if (name === 'Runner' || /Tests?$/.test(name)) continue
      if (!found.has(name)) found.set(name, 'xcode')
    }
  }
  return [...found].map(([name, source]) => ({ name, source }))
}

/** The workspace's fvm pin, if the project declares one. */
async function fvmPin(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  for (const file of ['.fvmrc', '.fvm/fvm_config.json']) {
    try {
      const parsed = JSON.parse(await readFile(join(cwd, file), 'utf8'))
      const version = parsed?.flutter ?? parsed?.flutterSdkVersion
      if (typeof version === 'string' && version !== '') return { file, version }
    } catch {
      continue
    }
  }
  return null
}

/** web / mobile / desktop, from the device's category or target platform. */
function deviceType(device) {
  const category = String(device.category ?? '').toLowerCase()
  if (category === 'web' || category === 'desktop' || category === 'mobile') {
    return device.emulator === true && category === 'mobile' ? 'mobile-emulator' : category
  }
  const platform = String(device.platform ?? device.targetPlatform ?? '').toLowerCase()
  if (platform.startsWith('web')) return 'web'
  if (platform === 'ios' || platform === 'android') return device.emulator === true ? 'mobile-emulator' : 'mobile'
  if (platform === 'darwin' || platform === 'windows' || platform === 'linux') return 'desktop'
  return 'unknown'
}

/** One device record, normalised from the daemon's or the CLI's shape. */
function normaliseDevice(device) {
  return {
    id: device.id,
    name: device.name,
    type: deviceType(device),
    targetPlatform: device.platform ?? device.targetPlatform,
    category: device.category,
    emulator: device.emulator === true,
    emulatorId: device.emulatorId ?? undefined,
    ephemeral: device.ephemeral === true,
    connection: device.connectionInterface ?? undefined,
    supported: device.isSupported !== false && device.isConnected !== false,
    sdk: device.sdk,
    hotReload: device.capabilities?.hotReload === true,
  }
}

/**
 * `flutter daemon` over stdio: JSON-RPC where every message is a one-element
 * JSON array. Devices arrive as `device.added` / `device.removed` events after
 * `device.enable`, so the list is live instead of polled; the same daemon also
 * hosts the DevTools server (`devtools.serve`).
 *
 * Note: `flutter daemon --machine` is NOT a valid flag — it exits 2 silently in
 * 3.47.5. The daemon speaks this protocol regardless of the flag.
 */
/**
 * A running app's VM Service over WebSocket. Node ships WebSocket, so this
 * needs no dependency; service extensions are ordinary JSON-RPC methods that
 * take the isolate id.
 */
class VmService {
  #url
  #socket = null
  #nextId = 1
  #pending = new Map()
  #connecting = null
  #isolateId = null

  constructor(vmServiceUri) {
    const url = new URL(vmServiceUri)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`
    url.search = ''
    this.#url = url.toString()
  }

  get uri() {
    return this.#url
  }

  async #connect() {
    if (this.#socket !== null && this.#socket.readyState === 1) return
    if (this.#connecting !== null) return this.#connecting
    this.#connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url)
      const timer = setTimeout(() => reject(new Error('VM Service did not answer')), DAEMON_REQUEST_TIMEOUT_MS)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error(`VM Service unreachable at ${this.#url}`)) }
      socket.onmessage = (event) => this.#onMessage(String(event.data))
      socket.onclose = () => {
        this.#socket = null
        this.#isolateId = null
        for (const [, waiter] of this.#pending) waiter.reject(new Error('VM Service connection closed'))
        this.#pending.clear()
      }
      this.#socket = socket
    }).finally(() => { this.#connecting = null })
    return this.#connecting
  }

  #onMessage(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const waiter = this.#pending.get(message.id)
    if (waiter === undefined) return
    this.#pending.delete(message.id)
    message.error ? waiter.reject(new Error(message.error.message ?? 'VM Service error')) : waiter.resolve(message.result)
  }

  async request(method, params) {
    await this.#connect()
    const id = this.#nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`VM Service ${method} timed out`))
      }, DAEMON_REQUEST_TIMEOUT_MS)
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.#socket.send(payload)
    })
  }

  /** The isolate the app runs in — extensions are called per isolate. */
  async isolateId() {
    if (this.#isolateId !== null) return this.#isolateId
    const vm = await this.request('getVM')
    const isolates = Array.isArray(vm?.isolates) ? vm.isolates : []
    const main = isolates.find((entry) => entry.name === 'main') ?? isolates[0]
    if (main?.id === undefined) throw new Error('the app has no running isolate')
    this.#isolateId = main.id
    return this.#isolateId
  }

  /** Extension names this app registered, e.g. `ext.flutter.debugPaint`. */
  async extensions() {
    const isolateId = await this.isolateId()
    const isolate = await this.request('getIsolate', { isolateId })
    return Array.isArray(isolate?.extensionRPCs) ? isolate.extensionRPCs : []
  }

  /** Heap usage of the main isolate (the RPC needs the isolate id). */
  async memoryUsage() {
    return this.request('getMemoryUsage', { isolateId: await this.isolateId() })
  }

  /** Triggers a collection: this VM exposes GC through the allocation profile. */
  async collectGarbage() {
    await this.request('getAllocationProfile', { isolateId: await this.isolateId(), gc: true })
    return this.memoryUsage()
  }

  /** Calls one extension; with no params it reads the current value. */
  async callExtension(name, params) {
    const isolateId = await this.isolateId()
    return this.request(name, { isolateId, ...(params ?? {}) })
  }

  close() {
    const socket = this.#socket
    this.#socket = null
    if (socket !== null) socket.close()
  }
}

/** Reads a toggle's state out of an extension response. */
function extensionState(name, response) {
  const spec = EXTENSIONS[name]
  if (spec === undefined) return undefined
  if (spec.kind === 'bool') return response?.enabled === 'true'
  const value = response?.value
  if (spec.kind === 'value') return String(value) === String(spec.on)
  return undefined
}

/**
 * One `flutter run --machine` child. The tool prints JSON arrays on stdout, so
 * `app.debugPort` hands us the VM Service URI — the panel launches on a device
 * and connects itself instead of asking for a URI typed from a terminal.
 * Input commands (`app.stop`) go back on stdin, the way the debug adapters do.
 */
class FlutterRun {
  #child = null
  #buffer = ''
  #appId = null
  #logs = []

  get running() {
    return this.#child !== null && this.#child.killed === false
  }

  start(flutter, cwd, deviceId, mode, options = {}) {
    if (this.running) throw new Error('the app is already being started from this panel')
    const args = ['run', '--machine', '-d', deviceId]
    if (mode === 'profile') args.push('--profile')
    if (mode === 'release') args.push('--release')
    const warnings = []
    let flavor = ''
    const requestedFlavor = typeof options.flavor === 'string' ? options.flavor.trim() : ''
    if (requestedFlavor !== '') {
      if (/^[A-Za-z0-9_-]{1,64}$/.test(requestedFlavor)) {
        args.push('--flavor', requestedFlavor)
        flavor = requestedFlavor
      } else {
        warnings.push(`flavor “${requestedFlavor}” rejected: letters, digits, hyphen and underscore only`)
      }
    }
    const defines = []
    const skipDefines = []
    const entries = Array.isArray(options.defines) ? options.defines.slice(0, 60) : []
    for (const entry of entries) {
      const key = String(entry?.key ?? '').trim()
      const value = String(entry?.value ?? '')
      if (key === '') continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { skipDefines.push(`${key}: the name must be a Dart identifier`); continue }
      if (value.includes('\n')) { skipDefines.push(`${key}: the value must not contain a newline`); continue }
      args.push(`--dart-define=${key}=${value}`)
      defines.push(`${key}=${value}`)
    }
    if (skipDefines.length > 0) warnings.push('skipped defines: ' + skipDefines.join('; '))
    const child = spawn(flutter, args, {
      cwd: cwd !== '' && existsSync(cwd) ? cwd : undefined,
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.#child = child
    this.#buffer = ''
    this.#logs = []
    this.#appId = null
    this.state = {
      running: true,
      deviceId,
      mode: mode ?? 'debug',
      flavor,
      defines,
      args,
      warnings,
      vmServiceUri: null,
      appId: null,
      error: null,
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => this.#log(String(chunk)))
    child.on('exit', (code) => {
      this.#child = null
      this.state = { ...this.state, running: false, exitCode: code }
      this.#log(`flutter run exited (${code})`)
    })
    return this.state
  }

  #log(line) {
    for (const entry of String(line).split('\n')) {
      if (entry.trim() === '') continue
      this.#logs.push(entry)
    }
    if (this.#logs.length > 200) this.#logs = this.#logs.slice(-200)
  }

  #onStdout(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line === '') continue
      if (line.startsWith('[')) {
        try {
          for (const message of JSON.parse(line)) this.#onMessage(message)
          continue
        } catch {
          // not a protocol line; fall through to the log
        }
      }
      this.#log(line)
    }
  }

  #onMessage(message) {
    const params = message.params ?? {}
    if (message.event === 'app.start') this.#appId = params.appId ?? this.#appId
    if (message.event === 'app.debugPort' && typeof params.wsUri === 'string') {
      // ws://127.0.0.1:PORT/TOKEN=/ws  →  http://127.0.0.1:PORT/TOKEN=/
      this.state = { ...this.state, vmServiceUri: params.wsUri.replace(/^ws/, 'http').replace(/\/ws$/, '/') }
    }
    if (message.event === 'app.started') this.#log('app started')
    if (message.event === 'app.stop') this.state = { ...this.state, running: false }
    if (message.event === 'app.webLaunchUrl' && typeof params.url === 'string') {
      this.state = { ...this.state, webUrl: params.url }
    }
    if (message.event === 'app.log') this.#log(params.log ?? params.error ?? '')
    if (message.event === 'daemon.showMessage') this.#log(`${params.level ?? ''}: ${params.message ?? ''}`)
    this.state = { ...this.state, appId: this.#appId }
  }

  /** Leaves the app running while the panel stops tracking it. */
  detach() {
    if (!this.running) return this.state_()
    try {
      this.#child.stdin.write(`${JSON.stringify([{ method: 'app.detach', params: { appId: this.#appId } }])}\n`)
    } catch {
      // the child may already be gone
    }
    this.state = { ...this.state, running: false, detached: true }
    this.#log('detached: the app keeps running')
    // Measured: the tool does NOT exit by itself after `app.detach` (it was still
    // there 20 s later), while a process-group kill takes the detached app down
    // with it. So the tool is killed by pid, and the app is left alone.
    const child = this.#child
    setTimeout(() => {
      for (const pid of toolPidsUnder(child?.pid)) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      if (child !== null) child.kill()
    }, 4000)
    return this.state_()
  }

  state_() {
    return { ...this.state, appId: this.#appId, logs: this.#logs.slice(-40) }
  }

  stop() {
    if (!this.running) return this.state_()
    try {
      this.#child.stdin.write(`${JSON.stringify([{ method: 'app.stop', params: { appId: this.#appId } }])}\n`)
    } catch {
      // the child may already be gone
    }
    const child = this.#child
    setTimeout(() => killTree(child), 4000)
    this.state = { ...this.state, running: false }
    return this.state_()
  }

  dispose() {
    const child = this.#child
    this.#child = null
    killTree(child)
  }
}

class FlutterDaemon {
  #flutter
  #cwd
  #child = null
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #devices = new Map()
  #starting = null
  #connected = null
  #devtools = null
  #onConnected = null
  #onConnectFailed = null

  constructor(flutter, cwd) {
    this.#flutter = flutter
    this.#cwd = cwd
  }

  get alive() {
    return this.#child !== null && this.#child.killed === false
  }

  async #ensure() {
    if (this.alive && this.#connected !== null) {
      await this.#connected
      return
    }
    if (this.#starting !== null) return this.#starting
    this.#starting = this.#spawn().finally(() => { this.#starting = null })
    return this.#starting
  }

  #spawn() {
    // No `--show-web-server-device`: measured, its only effect is adding the
    // synthetic `web-server` entry to the device list (4 instead of 3), which
    // makes the panel disagree with `flutter devices` for no gain.
    const child = spawn(this.#flutter, ['daemon'], {
      cwd: this.#cwd !== '' && existsSync(this.#cwd) ? this.#cwd : undefined,
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.#buffer = ''
    this.#devices.clear()
    this.#devtools = null
    this.#child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => console.log(`[dsh-flutter-panel] daemon: ${String(chunk).trimEnd()}`))
    child.on('exit', (code) => {
      this.#child = null
      this.#connected = null
      for (const [, waiter] of this.#pending) waiter.reject(new Error(`flutter daemon exited (${code})`))
      this.#pending.clear()
    })

    this.#connected = new Promise((resolve, reject) => {
      this.#onConnected = resolve
      this.#onConnectFailed = reject
      setTimeout(() => reject(new Error('flutter daemon did not report daemon.connected')), DAEMON_CONNECT_TIMEOUT_MS)
    })

    return this.#connected
      .then(() => this.#request('device.enable'))
      .then(() => undefined)
  }

  #onData(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line === '') continue
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        continue
      }
      for (const message of Array.isArray(payload) ? payload : [payload]) this.#onMessage(message)
    }
  }

  #onMessage(message) {
    if (message.event !== undefined) {
      if (message.event === 'daemon.connected') {
        console.log(`[dsh-flutter-panel] daemon connected v${message.params?.version ?? '?'}`)
        this.#onConnected?.()
      } else if (message.event === 'device.added') {
        const device = normaliseDevice(message.params ?? {})
        if (device.id) this.#devices.set(device.id, device)
      } else if (message.event === 'device.removed') {
        this.#devices.delete(message.params?.id)
      }
      return
    }
    const waiter = this.#pending.get(message.id)
    if (waiter === undefined) return
    this.#pending.delete(message.id)
    if (message.error === undefined) {
      waiter.resolve(message.result)
      return
    }
    // The daemon reports failures both as `{code, message}` and as a bare
    // string; keep the text useful either way instead of printing an empty one.
    const detail = typeof message.error === 'string'
      ? message.error
      : (message.error.message ?? JSON.stringify(message.error))
    waiter.reject(new Error(detail === '' ? 'daemon error' : detail))
  }

  #request(method, params) {
    if (!this.alive) return Promise.reject(new Error('flutter daemon is not running'))
    const id = this.#nextId++
    const payload = JSON.stringify([{ id, method, ...(params === undefined ? {} : { params }) }])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`daemon ${method} timed out`))
      }, DAEMON_REQUEST_TIMEOUT_MS)
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.#child.stdin.write(payload + '\n')
    })
  }

  /** The live device list; `device.getDevices` covers the first moments. */
  async devices() {
    await this.#ensure()
    if (this.#devices.size === 0) {
      const listed = await this.#request('device.getDevices')
      for (const raw of Array.isArray(listed) ? listed : []) {
        const device = normaliseDevice(raw)
        if (device.id) this.#devices.set(device.id, device)
      }
    }
    return [...this.#devices.values()]
  }

  /** Boots an emulator; the device then shows up as a `device.added` event. */
  async launchEmulator(emulatorId) {
    await this.#ensure()
    return this.#request('emulator.launch', { emulatorId, coldBoot: false })
  }

  async emulators() {
    await this.#ensure()
    const listed = await this.#request('emulator.getEmulators')
    return Array.isArray(listed) ? listed : []
  }

  /** The DevTools web server this daemon hosts, started on first use. */
  async devtoolsBase() {
    await this.#ensure()
    if (this.#devtools !== null) return this.#devtools
    const served = await this.#request('devtools.serve')
    if (served?.host === undefined || served?.port === undefined) throw new Error('devtools.serve returned no address')
    this.#devtools = `http://${served.host}:${served.port}`
    return this.#devtools
  }

  async version() {
    await this.#ensure()
    return this.#request('daemon.version')
  }

  dispose() {
    const child = this.#child
    this.#child = null
    this.#connected = null
    this.#devtools = null
    killTree(child)
  }
}

/** One stdio MCP client (JSON-RPC lines over the child's pipes). */
class McpChild {
  #child = null
  #nextId = 1
  #pending = new Map()
  #buffer = ''
  #starting = null

  get started() {
    return this.#child !== null && !this.#child.killed
  }

  async #start() {
    if (this.started) return
    if (this.#starting) return this.#starting
    this.#starting = new Promise((resolve, reject) => {
      const child = spawn(NPX, ['-y', MCP_PACKAGE], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), detached: true })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#onData(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => console.log(`[dsh-flutter-panel] ${String(chunk).trimEnd()}`))
      child.on('error', reject)
      child.on('exit', (code) => {
        this.#child = null
        for (const [, waiter] of this.#pending) waiter.reject(new Error(`flutter-devtools-mcp exited (${code})`))
        this.#pending.clear()
      })
      this.#child = child
      this.#request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-flutter-panel', version: '0.0.1' },
      })
        .then(() => {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
          resolve()
        })
        .catch(reject)
    }).finally(() => { this.#starting = null })
    return this.#starting
  }

  #onData(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = this.#pending.get(message.id)
      if (waiter === undefined) continue
      this.#pending.delete(message.id)
      message.error ? waiter.reject(new Error(message.error.message ?? 'MCP error')) : waiter.resolve(message.result)
    }
  }

  #request(method, params) {
    const id = this.#nextId++
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`MCP ${method} timed out`))
      }, MCP_CALL_TIMEOUT_MS)
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.#child.stdin.write(payload)
    })
  }

  async call(tool, args) {
    await this.#start()
    const result = await this.#request('tools/call', { name: tool, arguments: args ?? {} })
    const content = Array.isArray(result?.content) ? result.content : []
    const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    const images = content.filter((part) => part.type === 'image').map((part) => `data:${part.mimeType};base64,${part.data}`)
    return { isError: result?.isError === true, text, images }
  }

  close() {
    const child = this.#child
    this.#child = null
    killTree(child)
  }
}

/** DNS-rebinding fence: the request must carry a loopback Host header. */
function isLoopback(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Builds the /flutter routes, the daemon, and the MCP child.
 * Returns { handle, dispose } so a dev server can mount it without DSH.
 */
export function createFlutterPanel() {
  const mcp = new McpChild()
  const daemons = new Map()
  const deviceCache = new Map()
  const vmClients = new Map()
  const runs = new Map()

  function runFor(cwd) {
    const key = cwd ?? ''
    let run = runs.get(key)
    if (run === undefined) {
      run = new FlutterRun()
      runs.set(key, run)
    }
    return run
  }

  function vmFor(vmServiceUri) {
    let client = vmClients.get(vmServiceUri)
    if (client === undefined) {
      client = new VmService(vmServiceUri)
      vmClients.set(vmServiceUri, client)
    }
    return client
  }

  async function getDaemon(cwd) {
    const key = cwd ?? ''
    const flutter = await resolveFlutter(cwd)
    let entry = daemons.get(key)
    if (entry === undefined || entry.flutter !== flutter) {
      entry?.daemon.dispose()
      entry = { flutter, daemon: new FlutterDaemon(flutter, key) }
      daemons.set(key, entry)
    }
    return entry.daemon
  }

  /** The one-shot CLI, kept as the fallback when the daemon will not start. */
  async function devicesOnce(cwd) {
    const flutter = await resolveFlutter(cwd)
    const { stdout } = await run(flutter, ['devices', '--machine'], {
      cwd: typeof cwd === 'string' && cwd !== '' && existsSync(cwd) ? cwd : undefined,
      env: childEnv(),
      timeout: DEVICES_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout)
    return { flutter, devices: (Array.isArray(parsed) ? parsed : []).map(normaliseDevice), source: 'cli' }
  }

  async function devices(cwd, force) {
    const key = cwd ?? ''
    if (force !== true) {
      const cached = deviceCache.get(key)
      if (cached !== undefined) return cached
    }
    let payload
    try {
      const daemon = await getDaemon(cwd)
      payload = { flutter: await resolveFlutter(cwd), devices: await daemon.devices(), source: 'daemon' }
    } catch (error) {
      console.log(`[dsh-flutter-panel] daemon unavailable (${error.message}); falling back to flutter devices`)
      payload = await devicesOnce(cwd)
    }
    deviceCache.set(key, payload)
    // The daemon list is live, so the cache is only a snapshot for the next caller.
    setTimeout(() => deviceCache.delete(key), 5000)
    return payload
  }

  /** Runs one whitelisted Flutter CLI command in the workspace. */
  async function projectCommand(cwd, name) {
    const spec = PROJECT_COMMANDS[name]
    if (spec === undefined) throw new Error(`command not allowed: ${name}`)
    const flutter = await resolveFlutter(cwd)
    try {
      const { stdout, stderr } = await run(flutter, spec.args, {
        cwd: cwd !== '' && existsSync(cwd) ? cwd : undefined,
        env: childEnv(),
        timeout: spec.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      })
      return { flutter, text: `${stdout}${stderr}`.trim() }
    } catch (error) {
      // A non-zero exit is a normal answer here (outdated deps, failing doctor).
      const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
      if (text !== '') return { flutter, text, exitCode: error.code }
      throw error
    }
  }

  async function devtoolsUrl(cwd, page, vmServiceUri) {
    const daemon = await getDaemon(cwd)
    const base = await daemon.devtoolsBase()
    const query = new URLSearchParams()
    if (typeof vmServiceUri === 'string' && vmServiceUri !== '') query.set('uri', vmServiceUri)
    query.set('ide', 'dsh')
    const suffix = query.toString()
    return { base, url: `${base}/${page}${suffix === '' ? '' : `?${suffix}`}` }
  }

  const handle = async (req, res) => {
    if (!isLoopback(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = url.pathname.replace(/\/+$/, '') || '/flutter'
    const cwd = url.searchParams.get('cwd') ?? ''
    try {
      if (route === '/flutter' && req.method === 'GET') {
        const html = await readFile(join(HERE, 'panel.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
      if (route === '/flutter/config' && req.method === 'GET') {
        sendJson(res, 200, {
          cwd,
          fvm: await fvmPin(cwd),
          flutter: await resolveFlutter(cwd),
          npx: NPX,
          devtoolsPages: DEVTOOLS_PAGES,
          toggles: Object.fromEntries(Object.entries(EXTENSIONS).map(([name, spec]) => [name, spec.label])),
          commands: Object.fromEntries(Object.entries(PROJECT_COMMANDS).map(([name, spec]) => [name, spec.label])),
        })
        return
      }
      if (route === '/flutter/devices' && req.method === 'GET') {
        try {
          sendJson(res, 200, { ok: true, ...(await devices(cwd, url.searchParams.get('force') === '1')) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const stderr = typeof error?.stderr === 'string' ? error.stderr.trim().split('\n').slice(-4).join('\n') : ''
          sendJson(res, 200, { ok: false, error: message, stderr })
        }
        return
      }
      if (route === '/flutter/emulators' && req.method === 'GET') {
        try {
          const daemon = await getDaemon(cwd)
          sendJson(res, 200, { ok: true, emulators: await daemon.emulators() })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/flavors' && req.method === 'GET') {
        try {
          sendJson(res, 200, { ok: true, flavors: await discoverFlavors(cwd) })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/emulator/launch' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const emulatorId = typeof body?.emulatorId === 'string' ? body.emulatorId : ''
        if (emulatorId === '') {
          sendJson(res, 400, { ok: false, error: 'an emulatorId is required' })
          return
        }
        try {
          const daemon = await getDaemon(cwd)
          await daemon.launchEmulator(emulatorId)
          sendJson(res, 200, { ok: true, emulatorId })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/command' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const name = typeof body?.command === 'string' ? body.command : ''
        try {
          const result = await projectCommand(cwd, name)
          sendJson(res, 200, { ok: true, command: name, ...result, text: clipText(result.text) })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/heap' && req.method === 'GET') {
        const vmServiceUri = url.searchParams.get('uri') ?? ''
        if (vmServiceUri === '') {
          sendJson(res, 200, { ok: false, error: 'a VM Service URI is required' })
          return
        }
        try {
          const usage = await vmFor(vmServiceUri).memoryUsage()
          sendJson(res, 200, { ok: true, usage })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/gc' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const vmServiceUri = url.searchParams.get('uri') ?? body?.uri ?? ''
        if (vmServiceUri === '') {
          sendJson(res, 200, { ok: false, error: 'a VM Service URI is required' })
          return
        }
        try {
          const usage = await vmFor(vmServiceUri).collectGarbage()
          sendJson(res, 200, { ok: true, usage })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/run/detach' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, ...runFor(cwd).detach() })
        return
      }
      if (route === '/flutter/devtools' && req.method === 'GET') {
        const page = url.searchParams.get('page') ?? 'inspector'
        if (!DEVTOOLS_PAGES.includes(page)) {
          sendJson(res, 400, { ok: false, error: `unknown DevTools page: ${page}` })
          return
        }
        try {
          const built = await devtoolsUrl(cwd, page, url.searchParams.get('uri') ?? '')
          sendJson(res, 200, { ok: true, page, ...built })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/run' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...runFor(cwd).state_() })
        return
      }
      if (route === '/flutter/run' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : ''
        if (deviceId === '') {
          sendJson(res, 400, { ok: false, error: 'a deviceId is required' })
          return
        }
        try {
          const run = runFor(cwd)
          run.start(await resolveFlutter(cwd), cwd, deviceId, body?.mode, {
            flavor: body?.flavor,
            defines: body?.defines,
          })
          sendJson(res, 200, { ok: true, ...run.state_() })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/run/stop' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, ...runFor(cwd).stop() })
        return
      }
      if (route === '/flutter/extensions' && req.method === 'GET') {
        const vmServiceUri = url.searchParams.get('uri') ?? ''
        if (vmServiceUri === '') {
          sendJson(res, 200, { ok: false, error: 'a VM Service URI is required' })
          return
        }
        try {
          const client = vmFor(vmServiceUri)
          const registered = await client.extensions()
          const available = Object.keys(EXTENSIONS).filter((name) => registered.includes(name))
          const state = {}
          for (const name of available) {
            try {
              state[name] = extensionState(name, await client.callExtension(name))
            } catch (error) {
              state[name] = undefined
            }
          }
          sendJson(res, 200, { ok: true, isolateId: await client.isolateId(), available, state })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/extension' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const name = body?.name
        const spec = EXTENSIONS[name]
        if (spec === undefined) {
          sendJson(res, 400, { ok: false, error: `extension not allowed: ${String(name)}` })
          return
        }
        const vmServiceUri = url.searchParams.get('uri') ?? body?.uri ?? ''
        if (vmServiceUri === '') {
          sendJson(res, 200, { ok: false, error: 'a VM Service URI is required' })
          return
        }
        try {
          const client = vmFor(vmServiceUri)
          const params = spec.kind === 'bool'
            ? { enabled: body?.value === true }
            : { value: body?.value === true ? spec.on : spec.off }
          const response = await client.callExtension(name, params)
          sendJson(res, 200, { ok: true, name, state: extensionState(name, response) })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === '/flutter/call' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const tool = body?.tool
        if (typeof tool !== 'string' || !ALLOWED_TOOLS.has(tool)) {
          sendJson(res, 400, { ok: false, error: `tool not allowed: ${String(tool)}` })
          return
        }
        const args = { ...(body?.arguments ?? {}) }
        // The panel never guesses the project root: fill it from the session cwd.
        if (tool === 'collect_performance_session' && args.projectRoot === undefined && cwd !== '') {
          args.projectRoot = cwd
        }
        const result = await mcp.call(tool, args)
        sendJson(res, 200, { ok: true, tool, ...result })
        return
      }
      res.writeHead(404)
      res.end('not found')
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    handle,
    dispose: () => {
      mcp.close()
      for (const entry of daemons.values()) entry.daemon.dispose()
      daemons.clear()
      for (const client of vmClients.values()) client.close()
      vmClients.clear()
      for (const run of runs.values()) run.dispose()
      runs.clear()
    },
  }
}

export function apply(ctx) {
  const panel = createFlutterPanel()
  ctx.effect(() => () => panel.dispose(), 'dsh-flutter-panel: children')
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/flutter', handler: panel.handle }),
    'dsh-flutter-panel: /flutter route',
  )
}
