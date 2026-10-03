#
# To learn more about a Podspec see http://guides.cocoapods.org/syntax/podspec.html.
# Run `pod lib lint device_bridge.podspec` to validate before publishing.
#
Pod::Spec.new do |s|
  s.name             = 'device_bridge'
  s.version          = '0.0.1'
  s.summary          = 'RoadScope native location recorder.'
  s.description      = <<-DESC
RoadScope native location recorder for Android and iOS.
                       DESC
  s.homepage         = 'https://github.com/RichardstGG/RoadScope'
  s.license          = { :type => 'Proprietary', :text => 'Private RoadScope application component.' }
  s.author           = 'RoadScope'
  s.source           = { :path => '.' }
  s.source_files = 'device_bridge/Sources/device_bridge/**/*'
  s.dependency 'Flutter'
  s.platform = :ios, '15.0'

  # Flutter.framework does not contain a i386 slice.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'

  # If your plugin requires a privacy manifest, for example if it uses any
  # required reason APIs, update the PrivacyInfo.xcprivacy file to describe your
  # plugin's privacy impact, and then uncomment this line. For more information,
  # see https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
  # s.resource_bundles = {'device_bridge_privacy' => ['device_bridge/Sources/device_bridge/PrivacyInfo.xcprivacy']}
end
