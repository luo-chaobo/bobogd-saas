"use strict";

function requiredFeatureForPath(catalog, path) {
  const pathname = String(path || "").split("?", 1)[0];
  if (!Array.isArray(catalog)) return null;
  const feature = catalog.find((item) => (Array.isArray(item.apiPrefixes) ? item.apiPrefixes : []).some((prefix) =>
    pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)));
  return feature || null;
}

function canAccessApiPath(catalog, featureModules, path) {
  const feature = requiredFeatureForPath(catalog, path);
  return !feature || (Array.isArray(featureModules) && featureModules.includes(feature.key));
}

module.exports = { requiredFeatureForPath, canAccessApiPath };
