package com.aibox.app.device

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

/**
 * RN 原生桥：Agent 侧（Node 后端）通过动作队列把指令交给 RN 层，
 * RN 层调用本模块执行设备操作，再把结果回传给后端。
 */
class DeviceControlModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "DeviceControl"

    private val service get() = DeviceAccessibilityService.instance

    @ReactMethod
    fun getAppInfo(promise: Promise) {
        val map = Arguments.createMap()
        try {
            val info = reactApplicationContext.packageManager.getPackageInfo(
                reactApplicationContext.packageName, 0
            )
            map.putString("versionName", info.versionName ?: "")
            map.putInt("versionCode", info.versionCode)
        } catch (e: Exception) {
            map.putString("versionName", "")
            map.putInt("versionCode", 0)
        }
        promise.resolve(map)
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        val map = Arguments.createMap()
        map.putBoolean("serviceConnected", service != null)
        promise.resolve(map)
    }

    @ReactMethod
    fun executeAction(actionId: String, type: String, params: ReadableMap, promise: Promise) {
        val svc = service
        if (svc == null) {
            promise.reject("NO_SERVICE", "无障碍服务未连接，请先在系统设置中开启 Synaps 无障碍服务")
            return
        }
        val result = Arguments.createMap()
        try {
            when (type) {
                "tap" -> {
                    val x = params.getDouble("x").toFloat()
                    val y = params.getDouble("y").toFloat()
                    result.putBoolean("ok", svc.performTap(x, y))
                    result.putString("result", "tap($x, $y)")
                }
                "swipe" -> {
                    val x1 = params.getDouble("x1").toFloat()
                    val y1 = params.getDouble("y1").toFloat()
                    val x2 = params.getDouble("x2").toFloat()
                    val y2 = params.getDouble("y2").toFloat()
                    val dur = if (params.hasKey("duration")) params.getDouble("duration").toLong() else 400L
                    result.putBoolean("ok", svc.performSwipe(x1, y1, x2, y2, dur))
                    result.putString("result", "swipe($x1,$y1 -> $x2,$y2, ${dur}ms)")
                }
                "back" -> {
                    result.putBoolean("ok", svc.globalNav(AccessibilityService.GLOBAL_ACTION_BACK))
                    result.putString("result", "back")
                }
                "home" -> {
                    result.putBoolean("ok", svc.globalNav(AccessibilityService.GLOBAL_ACTION_HOME))
                    result.putString("result", "home")
                }
                "launch_app" -> {
                    val pkg = params.getString("package")
                    if (pkg.isNullOrEmpty()) {
                        promise.reject("BAD_PARAMS", "launch_app 需要 package 参数")
                        return
                    }
                    val intent = reactApplicationContext.packageManager.getLaunchIntentForPackage(pkg)
                    if (intent == null) {
                        promise.reject("NO_APP", "未找到应用：$pkg")
                        return
                    }
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    reactApplicationContext.startActivity(intent)
                    result.putBoolean("ok", true)
                    result.putString("result", "launch_app $pkg")
                }
                "screenshot" -> {
                    val handler = Handler(Looper.getMainLooper())
                    svc.takeScreenshot { path, w, h, code ->
                        handler.post {
                            if (path != null) {
                                result.putBoolean("ok", true)
                                result.putString("path", path)
                                result.putInt("width", w)
                                result.putInt("height", h)
                                promise.resolve(result)
                            } else {
                                promise.reject("SCREENSHOT_FAIL", "截图失败 code=$code")
                            }
                        }
                    }
                    return
                }
                "ui_dump" -> {
                    result.putBoolean("ok", true)
                    result.putString("ui", svc.uiDump(30000))
                }
                else -> {
                    promise.reject("BAD_TYPE", "未知动作类型：$type")
                    return
                }
            }
            promise.resolve(result)
        } catch (t: Throwable) {
            promise.reject("EXEC_ERROR", t.message ?: "执行失败")
        }
    }
}
