import * as fs from 'fs';
import * as path from 'path';

export interface ProjectTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  files: Record<string, string>;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'blank',
    name: '空白项目',
    icon: 'folder',
    description: '不生成任何文件，从空目录开始',
    files: {},
  },
  {
    id: 'android_kotlin',
    name: 'Android (Kotlin)',
    icon: 'android',
    description: 'Kotlin + Gradle 的 Android 应用骨架',
    files: {
      'settings.gradle.kts': `pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}
rootProject.name = "{{projectName}}"
include(":app")
`,
      'build.gradle.kts': `plugins {
  id("com.android.application") version "8.5.2" apply false
  id("org.jetbrains.kotlin.android") version "2.0.20" apply false
}
`,
      'gradle.properties': `org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
android.nonTransitiveRClass=true
`,
      'app/build.gradle.kts': `plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.example.app"
  compileSdk = 34

  defaultConfig {
    applicationId = "com.example.app"
    minSdk = 24
    targetSdk = 34
    versionCode = 1
    versionName = "1.0.0"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("com.google.android.material:material:1.12.0")
}
`,
      'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application
    android:label="{{projectName}}"
    android:theme="@style/Theme.Material.Light.NoActionBar">
    <activity
      android:name=".MainActivity"
      android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`,
      'app/src/main/java/com/example/app/MainActivity.kt': `package com.example.app

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(android.widget.TextView(this).apply {
      text = "Hello from {{projectName}}"
      textSize = 20f
    })
  }
}
`,
      'README.md': `# {{projectName}}

Android (Kotlin) 项目骨架。

## 构建

\`\`\`bash
./gradlew assembleDebug
\`\`\`
`,
      '.gitignore': `.gradle/
build/
local.properties
.idea/
*.iml
`,
    },
  },
  {
    id: 'react_native',
    name: 'React Native',
    icon: 'mobile-screen',
    description: 'Expo + TypeScript 的 React Native 应用骨架',
    files: {
      'package.json': `{
  "name": "{{projectName}}",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "web": "expo start --web"
  },
  "dependencies": {
    "expo": "~54.0.0",
    "expo-status-bar": "~3.0.0",
    "react": "19.1.0",
    "react-native": "0.81.5"
  },
  "devDependencies": {
    "@babel/core": "^7.25.0",
    "@types/react": "~19.1.0",
    "typescript": "^5.8.0"
  }
}
`,
      'index.js': `import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
`,
      'App.tsx': `import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{{projectName}}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
});
`,
      'tsconfig.json': `{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true
  }
}
`,
      'babel.config.js': `module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
`,
      'app.json': `{
  "expo": {
    "name": "{{projectName}}",
    "slug": "{{projectName}}",
    "version": "1.0.0",
    "orientation": "portrait",
    "userInterfaceStyle": "light"
  }
}
`,
      'README.md': `# {{projectName}}

React Native (Expo) 项目骨架。

## 启动

\`\`\`bash
npm install
npm start
\`\`\`
`,
      '.gitignore': `node_modules/
.expo/
dist/
web-build/
*.log
`,
    },
  },
  {
    id: 'node_js',
    name: 'Node.js',
    icon: 'node',
    description: 'TypeScript + Express 的 Node.js 服务骨架',
    files: {
      'package.json': `{
  "name": "{{projectName}}",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "echo \"No tests yet\""
  },
  "dependencies": {
    "express": "^4.21.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
`,
      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`,
      'src/index.ts': `import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: '{{projectName}} is running' });
});

app.listen(port, () => {
  console.log(\`Server listening at http://localhost:\${port}\`);
});
`,
      'README.md': `# {{projectName}}

Node.js + TypeScript + Express 服务骨架。

## 启动

\`\`\`bash
npm install
npm run dev
\`\`\`
`,
      '.gitignore': `node_modules/
dist/
*.log
.env
`,
    },
  },
  {
    id: 'python',
    name: 'Python',
    icon: 'python',
    description: 'FastAPI + uvicorn 的 Python 服务骨架',
    files: {
      'requirements.txt': `fastapi==0.115.0
uvicorn[standard]==0.30.6
pytest==8.3.3
`,
      'main.py': `from fastapi import FastAPI

app = FastAPI(title="{{projectName}}")


@app.get("/")
def root():
    return {"message": "{{projectName}} is running"}
`,
      'tests/test_main.py': `from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_root():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "message" in resp.json()
`,
      'README.md': `# {{projectName}}

Python (FastAPI) 服务骨架。

## 启动

\`\`\`bash
pip install -r requirements.txt
uvicorn main:app --reload
\`\`\`

## 测试

\`\`\`bash
pytest
\`\`\`
`,
      '.gitignore': `__pycache__/
*.pyc
.venv/
.env
`,
    },
  },
  {
    id: 'flutter',
    name: 'Flutter',
    icon: 'palette',
    description: 'Dart + Material 的 Flutter 应用骨架',
    files: {
      'pubspec.yaml': `name: {{projectName}}
description: A new Flutter project.
version: 1.0.0

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`,
      'lib/main.dart': `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '{{projectName}}',
      home: Scaffold(
        appBar: AppBar(title: const Text('{{projectName}}')),
        body: const Center(
          child: Text('Hello, {{projectName}}!'),
        ),
      ),
    );
  }
}
`,
      'analysis_options.yaml': `include: package:flutter_lints/flutter.yaml
`,
      'README.md': `# {{projectName}}

Flutter 应用骨架。

## 启动

\`\`\`bash
flutter pub get
flutter run
\`\`\`
`,
      '.gitignore': `.dart_tool/
build/
.flutter-plugins
.packages
`,
    },
  },
];

export function getProjectTemplate(id: string): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function listProjectTemplates(): Array<Pick<ProjectTemplate, 'id' | 'name' | 'icon' | 'description'>> {
  return PROJECT_TEMPLATES.map(({ id, name, icon, description }) => ({ id, name, icon, description }));
}

export function scaffoldProject(
  projectPath: string,
  templateId: string,
  projectName: string
): { created: string[]; skipped: string[] } {
  const tpl = getProjectTemplate(templateId);
  if (!tpl) return { created: [], skipped: [] };

  const safeName = projectName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'synaps-app';
  const created: string[] = [];
  const skipped: string[] = [];

  for (const [relPath, rawContent] of Object.entries(tpl.files)) {
    const target = path.join(projectPath, relPath);
    if (fs.existsSync(target)) {
      skipped.push(relPath);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rawContent.split('{{projectName}}').join(safeName), 'utf-8');
    created.push(relPath);
  }
  return { created, skipped };
}
