// electron-builder afterPack hook for the Display Client: the NDI runtime is bundled with the
// app (NDI SDK "Binary Files" may ship inside the application), so station PCs don't need the
// NDI Runtime installed. Fail the build if the NDI library didn't make it in.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const want = platform === 'win32' ? /^Processing\.NDI\.Lib\.x64\.dll$/i : platform === 'darwin' ? /\.dylib$/ : /^libndi\.so/;
  const root = path.join(context.appOutDir, platform === 'darwin' ? `${context.packager.appInfo.productFilename}.app/Contents/Resources` : 'resources', 'app.asar.unpacked', 'node_modules', '@stagetimerio', 'grandiose', 'dist');
  const files = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const lib = files.find((f) => want.test(f));
  const addon = files.includes('grandiose.node');
  if (!lib || !addon) {
    throw new Error(`NDI is not bundled for ${platform}: ${root} has [${files.join(', ') || 'nothing'}]. ` +
      'Build the Display Client on Windows after "npm run ndi:install" (it downloads the NDI SDK and puts Processing.NDI.Lib.x64.dll in node_modules/@stagetimerio/grandiose/dist).');
  }
  console.log(`  • NDI bundled: ${lib} (${(fs.statSync(path.join(root, lib)).size / 1e6).toFixed(1)} MB) + grandiose.node`);
};
