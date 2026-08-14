// Config plugin: keeps the embedded-Node startup call in MainActivity
// even after `npx expo prebuild` regenerates the android project.
const { withMainActivity, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withNodeBridge(config) {
  config = withMainActivity(config, (cfg) => {
    const src = cfg.modResults.contents;
    const marker = 'private var nodeServiceStarted = false';
    if (!src.includes(marker)) {
      cfg.modResults.contents = src.replace(
        'class MainActivity : ReactActivity() {',
        'class MainActivity : ReactActivity() {\n' +
          '  private var nodeServiceStarted = false\n\n' +
          '  // Start the embedded Node server once the activity is actually resumed\n' +
          '  // (foreground). Starting in onCreate is racy on Android 16: the system can\n' +
          '  // reject it with "Background start not allowed".\n' +
          '  override fun onResume() {\n' +
          '    super.onResume()\n' +
          '    if (!nodeServiceStarted) {\n' +
          '      nodeServiceStarted = true\n' +
          '      try {\n' +
          '        startService(android.content.Intent(this, com.aibox.app.node.NodeService::class.java))\n' +
          '      } catch (t: Throwable) {\n' +
          '        android.util.Log.e("SYNAPS_NODE", "failed to start NodeService", t)\n' +
          '      }\n' +
          '    }\n' +
          '  }'
      );
    }
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = manifest.manifest.application && manifest.manifest.application[0];
    if (app) {
      const svc = (app.service || []).find((s) => s.$ && s.$.name === '.node.NodeService');
      if (!svc) {
        app.service = app.service || [];
        app.service.push({
          $: {
            'android:name': '.node.NodeService',
            'android:process': ':node',
            'android:exported': 'false'
          }
        });
      }
    }
    return cfg;
  });
  return config;
};
