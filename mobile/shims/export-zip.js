// Shim for electron/services/exporter/export-zip in the mobile (WebView) context.
// The desktop export writes its ZIP through Node streams (stream/web, zip.js's
// native entry point), none of which exist in a WebView. Mobile never reaches it:
// AppExporterDialog overrides runExport with the native Kotlin/Swift zip export,
// so this only keeps the desktop module out of the bundle.
const unavailable = () => Promise.reject(new Error('Desktop ZIP export is not available on mobile.'));

module.exports = {
    writeExportZip: unavailable,
    verifyExportZip: unavailable,
};
