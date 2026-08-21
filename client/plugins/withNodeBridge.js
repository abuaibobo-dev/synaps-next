// Config plugin: preserves embedded-Node foreground startup and keep-alive manifest entries.
const { withAndroidManifest, withMainActivity } = require('expo/config-plugins');

const KEEP_ALIVE_PERMISSIONS = [
  'android.permission.WAKE_LOCK',
  'android.permission.RECEIVE_BOOT_COMPLETED',
];

module.exports = function withNodeBridge(config) {
  return withAndroidManifest(withMainActivity(config, (cfg) => {
    const src = cfg.modResults.contents;
    if (!src.includes('com.aibox.app.node.NodeService::class.java')) {
      cfg.modResults.contents = src.replace(
        'super.onCreate(null)',
        [
          'super.onCreate(null)',
          'val nodeServiceIntent = android.content.Intent(this, com.aibox.app.node.NodeService::class.java)',
          'if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) startForegroundService(nodeServiceIntent)',
          'else startService(nodeServiceIntent)',
        ].join('\n    ')
      );
    }
    return cfg;
  }), (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    for (const name of KEEP_ALIVE_PERMISSIONS) {
      if (!manifest['uses-permission'].some((item) => item.$?.['android:name'] === name)) {
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }
    manifest.application = manifest.application || [];
    for (const application of manifest.application) {
      application.receiver = application.receiver || [];
      if (!application.receiver.some((item) => item.$?.['android:name'] === '.node.BootReceiver')) {
        application.receiver.push({
          $: {
            'android:name': '.node.BootReceiver',
            'android:enabled': 'true',
            'android:exported': 'false',
          },
          'intent-filter': [{
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.QUICKBOOT_POWERON' } },
            ],
          }],
        });
      }
    }
    return cfg;
  });
};
