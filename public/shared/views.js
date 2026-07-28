// The view registry — and the enforcement point for the NO STUBS law.
//
// Five "coming soon" tabs are what told the crew the old app was a toy, so the
// dock is not a hand-written list of intentions. It is generated from what is
// actually registered here. A surface appears in navigation on the commit that
// ships it, and not before.

const views = new Map();

/**
 * @param {object} v
 * @param {string} v.id      stable key
 * @param {string} v.path    route this view owns
 * @param {string} v.title   topbar title
 * @param {string} v.label   dock label (short — it sits under an icon)
 * @param {string} v.icon
 * @param {boolean} [v.inDock=true]   deep-link-only surfaces set this false
 * @param {boolean} [v.adminOnly=false]
 * @param {string[]} [v.alsoOwns]     extra paths routed to this view
 * @param {(ctx:object)=>Promise<void>|void} v.mount
 */
export function register(v) {
  if (views.has(v.id)) throw new Error(`view "${v.id}" registered twice`);
  views.set(v.id, { inDock: true, adminOnly: false, alsoOwns: [], ...v });
}

export function all() {
  return [...views.values()];
}

export function dockViews({ isAdmin = false } = {}) {
  return all().filter((v) => v.inDock && (!v.adminOnly || isAdmin));
}

export function matchPath(pathname) {
  for (const v of views.values()) {
    if (v.path === pathname || v.alsoOwns.includes(pathname)) return v;
  }
  return null;
}

export function byId(id) {
  return views.get(id) ?? null;
}

export function count() {
  return views.size;
}
