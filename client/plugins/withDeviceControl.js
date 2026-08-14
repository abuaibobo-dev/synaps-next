// Config plugin: injects the accessibility service declaration and its
// resources into the Android manifest, so `npx expo prebuild` keeps the
// device-control capability after regenerating the android project.
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_XML = `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeWindowStateChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagDefault|flagRetrieveInteractiveWindows"
    android:canPerformGestures="true"
    android:canRetrieveWindowContent="true"
    android:canTakeScreenshot="true"
    android:notificationTimeout="100"
    android:description="@string/accessibility_service_description" />
`;

module.exports = function withDeviceControl(config) {
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = manifest.manifest.application && manifest.manifest.application[0];
    if (app) {
      const services = app.service || [];
      const exists = services.some(
        (s) => s.$ && s.$.name === '.device.DeviceAccessibilityService'
      );
      if (!exists) {
        services.push({
          $: {
            'android:name': '.device.DeviceAccessibilityService',
            'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
            'android:exported': 'false',
            'android:label': 'Synaps 设备控制',
          },
          'intent-filter': [
            {
              action: [
                {
                  $: { 'android:name': 'android.accessibilityservice.AccessibilityService' },
                },
              ],
            },
          ],
          'meta-data': [
            {
              $: {
                'android:name': 'android.accessibilityservice',
                'android:resource': '@xml/accessibility_service_config',
              },
            },
          ],
        });
        app.service = services;
      }
    }
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const resDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res');
      const xmlDir = path.join(resDir, 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'accessibility_service_config.xml'), SERVICE_XML);

      const valuesDir = path.join(resDir, 'values');
      fs.mkdirSync(valuesDir, { recursive: true });
      const stringsPath = path.join(valuesDir, 'strings.xml');
      let strings = fs.existsSync(stringsPath)
        ? fs.readFileSync(stringsPath, 'utf8')
        : '<resources>\n</resources>\n';
      if (!strings.includes('accessibility_service_description')) {
        strings = strings.replace(
          '</resources>',
          '    <string name="accessibility_service_description">Synaps 设备控制：允许 AI 代理读取屏幕内容并模拟点击、滑动、截图等操作</string>\n</resources>'
        );
        fs.writeFileSync(stringsPath, strings);
      }
      return cfg;
    },
  ]);

  return config;
};
