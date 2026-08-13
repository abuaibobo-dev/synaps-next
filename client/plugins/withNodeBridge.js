// Config plugin: keeps the embedded-Node startup call in MainActivity
// even after `npx expo prebuild` regenerates the android project.
const { withMainActivity } = require('expo/config-plugins');

module.exports = function withNodeBridge(config) {
  return withMainActivity(config, (cfg) => {
    const src = cfg.modResults.contents;
    const marker = 'com.aibox.app.node.NodeBridge.start(applicationContext)';
    if (!src.includes(marker)) {
      cfg.modResults.contents = src.replace(
        'super.onCreate(null)',
        'super.onCreate(null)\n    ' + marker
      );
    }
    return cfg;
  });
};
