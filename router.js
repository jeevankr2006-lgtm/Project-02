'use strict';

// Compiles registry paths like "/tickets/:id/history" into regular expressions.
class Router {
  constructor(registry) {
    this.routes = registry.map((entry) => {
      const names = [];
      const pattern = entry.path.replace(/:([A-Za-z]+)/g, (_, name) => {
        names.push(name);
        return '([^/]+)';
      });
      return { entry, names, re: new RegExp(`^${pattern}$`) };
    });
  }

  match(method, path) {
    for (const r of this.routes) {
      if (r.entry.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = {};
      try {
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      } catch {
        return null; // malformed percent-encoding: treat as unknown route
      }
      return { entry: r.entry, params };
    }
    return null;
  }
}

module.exports = { Router };
