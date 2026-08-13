// Config plugin: keeps the embedded-Node startup call in MainActivity
// even after `npx expo prebuild` regenerates the android project.
const { withMainActivity, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withNodeBridge(config) {
  config = withMainActivity(config, (cfg) => {
    const src = cfg.modResults.contents;
    const marker = 'startService(new android.content.Intent(this, com.aibox.app.node.NodeService.class))';
    if (!src.includes(marker)) {
      cfg.modResults.contents = src.replace(
        'super.onCreate(null)',
        'super.onCreate(null)\n    try {\n      ' + marker + '\n    } catch (t: Throwable) {}\n'
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
