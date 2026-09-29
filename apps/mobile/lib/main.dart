import 'package:flutter/material.dart';

void main() => runApp(const RoadScopeApp());

class RoadScopeApp extends StatelessWidget {
  const RoadScopeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RoadScope',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
      ),
      home: const BootstrapScreen(),
    );
  }
}

class BootstrapScreen extends StatelessWidget {
  const BootstrapScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('RoadScope')),
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.route,
                  size: 64,
                  color: Theme.of(context).colorScheme.primary,
                ),
                const SizedBox(height: 20),
                Text(
                  '定位診斷',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 12),
                const Text(
                  '記錄器尚未啟用',
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
