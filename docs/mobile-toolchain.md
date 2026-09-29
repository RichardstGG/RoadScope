# 手機端工具版本與建置入口

本文件記錄 P0 手機端的可重現工具基準。使用 Flutter **3.47.3 stable**（內附 Dart **3.13.3**）及 JDK **21**。Linux 與 Mac 使用同一 Flutter 版本。版本依 [Flutter SDK archive](https://docs.flutter.dev/install/archive) 與 [Flutter changelog](https://github.com/flutter/flutter/blob/master/CHANGELOG.md) 選定；升級時以獨立 PR 更新版本、鎖檔與 CI，並重跑雙平台建置。

App 識別碼前綴為 **`tw.idv.richardwutt`**，Flutter 專案名稱為 `roadscope`；Android application ID／iOS bundle ID 為 **`tw.idv.richardwutt.roadscope`**。Flutter 3.47.3 模板生成 Android Gradle Plugin **9.1.0**、Kotlin **2.4.0**、Gradle wrapper **9.3.1**，iOS deployment target **15.0**。Android 的 compile SDK、min SDK 和 target SDK 仍使用 Flutter 模板提供的值；本次 Linux debug build 實際使用 Android SDK Platform **36**、NDK **28.2.13676358** 與 CMake **3.22.1**。

在 Linux 安裝對應版本 Flutter、JDK 21 和 Android SDK 後，從專案根目錄執行：

```sh
flutter --version
flutter doctor -v
cd apps/mobile
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

Android／iOS 模板已由上述固定版本的 `flutter create` 產生，`pubspec.lock` 由 `flutter pub get` 產生；升級模板或依賴時應檢查 diff。Mac 使用相同 commit 執行：

```sh
flutter --version
flutter doctor -v
cd apps/mobile
flutter pub get
flutter build ios --no-codesign
```

iPhone 真機安裝另需簽署；Android 發布簽署尚未設定。背景定位、耗電及資料恢復依 `05-mac-iphone-checklist.md` 執行並記錄設備型號／系統版本。上述 build 命令只能驗證編譯，不能替代真機背景採集測試。
