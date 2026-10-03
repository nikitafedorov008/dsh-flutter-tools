/*!
 * dsh-flutter-tools — client half (browser bundle).
 *
 * Registers a Flutter page with dsh-better-sidebar via `ctx.betterSidebar`.
 * The page body is an iframe onto the plugin's own /flutter host route, so all
 * panel logic lives in plain HTML/JS served by the host half — no build step.
 *
 * An iframe is a separate document and inherits nothing, so this half copies
 * the live `--dsw-*` design tokens (and the theme markers) from the app's root
 * into the frame and re-syncs on every theme change. Names come from the app's
 * stylesheets, its adopted stylesheets, and a built-in fallback list — the app
 * may inject its theme in any of those three ways, and if every source comes up
 * empty the frame still gets the app's resolved foreground colour instead of a
 * guessed one.
 *
 * Bundle format: the DSH client-bundle shape — a lazy-CJS closure registered
 * with window.__ModuleLoader__.load({ id, factory }); `react` is an external
 * resolved from the shell's module table at runtime.
 */
window.__ModuleLoader__.load({
  id: 'dsh-flutter-tools',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict';

    var React = require('react');

    /** Theme markers mirrored onto the frame's root element. */
    var THEME_ATTRS = ['class', 'data-theme', 'data-color-scheme', 'data-mode', 'dir', 'lang'];

    /** Tokens the panel stylesheet actually reads; a fallback for a theme that
     *  is injected in a way the CSSOM walk cannot see (adopted stylesheets,
     *  late <style> injection, a cross-origin sheet). */
    var BUILTIN_TOKENS = [
      '--dsw-font-family',
      '--dsw-font-markdown-code-font-family',
      '--dsw-radius-sm',
      '--dsw-radius-md',
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-l1',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-layer-3',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-border-l3',
      '--dsw-alias-border-l4',
      '--dsw-alias-label',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-primary-foreground',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-label-dimmed',
      '--dsw-alias-label-caption',
      '--dsw-alias-label-error',
      '--dsw-alias-link',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-interactive-bg-active',
      '--dsw-alias-button-primary-fill',
      '--dsw-alias-button-primary-hover',
      '--dsw-alias-button-ghost-active-fill',
      '--dsw-alias-button-ghost-active-border',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-business-primary',
      '--dsw-alias-markdown-code-block',
      '--dsw-alias-markdown-inline-code'
    ];

    var tokenNames = null;

    /** Every `--dsw-*` custom property the app declares, however it declares them. */
    function collectTokenNames() {
      if (tokenNames !== null) return tokenNames;
      var names = new Set(BUILTIN_TOKENS);
      var walk = function (rules) {
        for (var i = 0; i < rules.length; i++) {
          var rule = rules[i];
          var style = rule.style;
          if (style) {
            for (var j = 0; j < style.length; j++) {
              var property = style[j];
              if (property.slice(0, 6) === '--dsw-') names.add(property);
            }
          }
          if (rule.cssRules) walk(rule.cssRules);
        }
      };
      var sources = [];
      var sheets = document.styleSheets || [];
      for (var s = 0; s < sheets.length; s++) sources.push(sheets[s]);
      var adopted = document.adoptedStyleSheets || [];
      for (var a = 0; a < adopted.length; a++) sources.push(adopted[a]);
      for (var k = 0; k < sources.length; k++) {
        try {
          walk(sources[k].cssRules);
        } catch (error) {
          continue; // cross-origin sheet; the app's own theme is same-origin
        }
      }
      if (names.size > BUILTIN_TOKENS.length) tokenNames = names;
      return names;
    }

    /** The value of a token: the app's root, then its body, then the frame itself. */
    function readToken(view, name) {
      var scope = [document.documentElement, document.body];
      for (var i = 0; i < scope.length; i++) {
        if (!scope[i]) continue;
        var value = view.getComputedStyle(scope[i]).getPropertyValue(name);
        if (value && value.trim() !== '') return value.trim();
      }
      return '';
    }

    /** Copy the app's live theme into the panel document. */
    function applyTheme(frame) {
      if (!frame) return;
      var target;
      try {
        target = frame.contentDocument && frame.contentDocument.documentElement;
      } catch (error) {
        return; // not same-origin
      }
      if (!target) return;

      var view = document.defaultView;
      if (!view) return;
      var source = document.documentElement;
      var computed = view.getComputedStyle(source);
      var names = collectTokenNames();
      var copied = 0;
      names.forEach(function (name) {
        var value = readToken(view, name);
        if (value === '') return;
        target.style.setProperty(name, value);
        copied += 1;
      });

      if (computed.colorScheme) target.style.colorScheme = computed.colorScheme;
      for (var i = 0; i < THEME_ATTRS.length; i++) {
        var attr = THEME_ATTRS[i];
        var attrValue = source.getAttribute(attr);
        if (attrValue === null) target.removeAttribute(attr);
        else target.setAttribute(attr, attrValue);
      }

      // No token source at all: fall back to concrete colours so the panel can
      // never end up as dark text on a dark ground.
      if (copied === 0) {
        var ground = view.getComputedStyle(document.body || source);
        target.style.color = ground.color;
        target.style.backgroundColor = ground.backgroundColor;
      }
    }

    /** Flutter's own mark (simple-icons path, CC0), filled in the tab's colour. */
    function IconFlutter16(size) {
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true'
      }, React.createElement('path', {
        d: 'M14.314 0L2.3 12 6 15.7 21.684.013h-7.357zm.014 11.072L7.857 17.53l6.47 6.47H21.7l-6.46-6.468 6.46-6.46h-7.37z',
        fill: 'currentColor'
      }));
    }

    /** Tab body: the host route carries the session scope in its query. */
    function FlutterPanel(props) {
      var scope = props.scope || {};
      var ref = React.useRef(null);
      var params = ['sessionId=' + encodeURIComponent(scope.sessionId || '')];
      if (scope.cwd !== undefined && scope.cwd !== '') params.push('cwd=' + encodeURIComponent(scope.cwd));
      var src = '/flutter?' + params.join('&');

      React.useEffect(function () {
        var frame = ref.current;
        var sync = function () { applyTheme(ref.current); };
        sync();
        if (frame) frame.addEventListener('load', sync);
        // The theme may land after the first paint; re-sync a couple of times.
        var timers = [setTimeout(sync, 120), setTimeout(sync, 600)];
        var observer = new MutationObserver(sync);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: THEME_ATTRS.concat(['style'])
        });
        if (document.head) observer.observe(document.head, { childList: true, subtree: true });
        return function () {
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          if (frame) frame.removeEventListener('load', sync);
          observer.disconnect();
        };
      }, []);

      return React.createElement('iframe', {
        ref: ref,
        src: src,
        title: 'Flutter',
        style: { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' }
      });
    }

    module.exports = {
      inject: ['betterSidebar', 'sidebarRight'],
      apply: function (ctx) {
        // ctx.effect so the disposer from registerTab runs on teardown (HMR /
        // plugin disable); a stray registration would throw "already registered".
        ctx.effect(function () {
          return ctx.betterSidebar.registerTab({
            id: 'dsh-flutter-tools:panel',
            title: 'Flutter',
            description: 'Flutter: VM Service connection, hot reload, profiling, performance session',
            icon: function (size) { return IconFlutter16(size); },
            single: true,
            component: FlutterPanel
          });
        });
        // The panel body is an iframe and has no access to the sidebar; it asks
        // for a DevTools page over postMessage and this half opens the tab.
        ctx.effect(function () {
          var onMessage = function (event) {
            if (event.origin !== window.location.origin) return;
            var data = event.data;
            if (!data || data.type !== 'dsh-flutter-open-url' || typeof data.url !== 'string') return;
            ctx.sidebarRight.openTab('browser', { params: { url: data.url }, revealIfOpened: false });
          };
          window.addEventListener('message', onMessage);
          return function () { window.removeEventListener('message', onMessage) };
        });
      }
    };

    return module.exports;
  }
});
