// Loads a USDZ with Apple's own ModelIO + SceneKit and prints what it found as JSON (macOS only).
import Foundation
import ModelIO
import SceneKit

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = MDLAsset(url: url)
let meshes = asset.childObjects(of: MDLMesh.self) as! [MDLMesh]
let skeletons = asset.childObjects(of: MDLSkeleton.self) as! [MDLSkeleton]
var skinners = 0, animKeys = 0
if let scene = try? SCNScene(url: url, options: nil) {
  scene.rootNode.enumerateHierarchy { n, _ in
    if n.skinner != nil { skinners += 1 }
    animKeys += n.animationKeys.count
  }
}
let out: [String: Any] = ["meshes": meshes.count, "joints": skeletons.first?.jointPaths.count ?? 0, "skinners": skinners, "animations": animKeys]
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
