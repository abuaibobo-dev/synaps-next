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
          '  // Start the embedded Node server as a foreground service. Plain\n' +
          '  // startService() is blocked by Android 16 ("Background start not allowed")\n' +
          '  // even from onCreate/onResume, so use the FGS path which is always allowed.\n' +
          '  override fun onResume() {\n' +
          '    super.onResume()\n' +
          '    if (!nodeServiceStarted) {\n' +
          '      nodeServiceStarted = true\n' +
          '      try {\n' +
          '        val intent = android.content.Intent(this, com.aibox.app.node.NodeService::class.java)\n' +
          '        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {\n' +
          '          startForegroundService(intent)\n' +
          '        } else {\n' +
          '          startService(intent)\n' +
          '        }\n' +
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
    // permissions
    const perms = manifest.manifest['uses-permission'] || [];
    const needed = {
      'android.permission.FOREGROUND_SERVICE': true,
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE': true,
      'android.permission.POST_NOTIFICATIONS': true,
    };
    for (const p of perms) {
      if (p.$ && p.$.name && needed[p.$.name]) delete needed[p.$.name];
    }
    for (const name of Object.keys(needed)) {
      perms.push({ $: { 'android:name': name } });
    }
    manifest.manifest['uses-permission'] = perms;

    const app = manifest.manifest.application && manifest.manifest.application[0];
    if (app) {
      const svc = (app.service || []).find((s) => s.$ && s.$.name === '.node.NodeService');
      if (!svc) {
        app.service = app.service || [];
        app.service.push({
          $: {
            'android:name': '.node.NodeService',
            'android:process': ':node',
            'android:exported': 'false',
            'android:foregroundServiceType': 'specialUse',
          },
          property: [
            {
              $: {
                'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
                'android:value': 'embedded node.js backend server',
              },
            },
          ],
        });
      }
    }
    return cfg;
  });
  return config;
};
