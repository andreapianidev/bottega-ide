// Run with scripts/test-osservatorio.sh. Exercises the real projection, picking and label allocator.
import AppKit

// SkyScene only needs the identity of an engine pulse; no GPU required for these checks.
enum MetalEngine {
    struct Pulse { var key: String; var project: String }
}

@main
struct OsservatorioGeometryTests {
    static func main() {
        let observed = OsservatorioData.decode(["periods": ["7": ["days": 7, "projects": [["name": "Faro", "path": "/test/Faro", "you": 0, "observedOnly": true, "live": 1]]]], "live": [["project": "Faro", "path": "/test/Faro", "status": "ti aspetta"]]])
        assert(observed.periods["7"]?.projects.first?.observedOnly == true)
        let observedScene = OsservatorioCielo.scene(observed, period: "7", version: 1)
        assert(observedScene.stars.count == 1 && observedScene.stars[0].live)
        var scene = SkyScene.sample(count: 48)
        scene.stars[0].name = "Un progetto con un nome molto lungo per verificare i bordi del cielo"
        SkyGeometry.relax(&scene.stars)
        var combinations = 0
        for size in [CGSize(width: 420, height: 320), CGSize(width: 902, height: 450), CGSize(width: 1600, height: 900)] {
            let field = SkyGeometry.fieldRect(size: size, insets: NSEdgeInsets(top: 72, left: 28, bottom: 72, right: 28))
            assert(field.minX == 28 && field.minY == 72 && field.maxX == size.width - 28)
            assert(field.maxY == size.height - 72)
            for yaw: Float in [-0.85, 0, 0.85] {
                for pitch: Float in [-0.55, 0, 0.55] {
                    for zoom: Float in [0.7, 1, 1.4] {
                        let camera = SkyCamera(yaw: yaw, pitch: pitch, zoom: zoom)
                        let projected = camera.project(scene)
                        assert(projected.stars.map(\.key) == scene.stars.map(\.key))
                        assert(projected.edges == scene.edges)
                        for (i, star) in projected.stars.enumerated() {
                            assert(star.position.x.isFinite && star.position.y.isFinite && star.size > 0)
                            let point = SkyGeometry.point(of: star, in: field)
                            assert(SkyGeometry.pick(point, scene: projected, field: field) == i)
                        }
                        for big in [false, true] {
                            let labels = SkyLabelLayout.place(scene: projected, field: field, selected: 0, hovered: 3, big: big)
                            for (i, label) in labels.enumerated() {
                                assert(field.contains(label.frame), "Label escaped its field")
                                for other in labels.dropFirst(i + 1) {
                                    assert(!label.frame.intersects(other.frame), "Labels overlapped")
                                }
                            }
                            combinations += 1
                        }
                    }
                }
            }
        }
        var camera = SkyCamera()
        camera.orbit(dx: 100_000, dy: -100_000)
        camera.magnify(100)
        assert(camera.yaw == 0.85 && camera.pitch == -0.55 && camera.zoom == 1.4)
        camera.magnify(-100)
        assert(camera.zoom == 0.7)
        let field = CGRect(x: 0, y: 0, width: 600, height: 400)
        assert(SkyLabelLayout.place(scene: SkyScene(), field: field, selected: nil, hovered: nil, big: false).isEmpty)
        assert(SkyGeometry.pick(.zero, scene: SkyScene(), field: field) == nil)
        print("OsservatorioGeometryTests passed: \(combinations) layouts, 48 projects, orbit/zoom extremes, picking, label collisions, empty scene")
    }
}
