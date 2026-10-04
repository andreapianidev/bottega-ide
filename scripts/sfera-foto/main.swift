// Programma di scripts/sfera-foto/fai.sh: disegna fuori schermo la sfera del Nucleo e la salva in PNG.
import Metal
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation

// uso: sfera <OrbShaders.metal> <stato> <lato px> <secondi> <uscita.png>
let a = CommandLine.arguments
MetalEngine.sorgente = try! String(contentsOfFile: a[1], encoding: .utf8)
let stato = Int32(a[2])!, lato = Int(a[3])!, secondi = Double(a[4])!, uscita = a[5]
let device = MetalEngine.shared.device!
guard let lib = OrbLibrary.load(device: device),
      let r = OrbRenderer(device: device, library: lib, pixelFormat: .rgba16Float) else { fatalError("renderer") }
r.state = stato
r.docked = a.count > 6 && a[6] == "piccola"
let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: lato, height: lato, mipmapped: false)
d.usage = [.renderTarget, .shaderRead]; d.storageMode = .shared
let tex = device.makeTexture(descriptor: d)!
let q = device.makeCommandQueue()!
let fine = Date().addingTimeInterval(secondi)
while Date() < fine {
    let rpd = MTLRenderPassDescriptor()
    rpd.colorAttachments[0].texture = tex
    rpd.colorAttachments[0].loadAction = .clear
    rpd.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    rpd.colorAttachments[0].storeAction = .store
    let cmd = q.makeCommandBuffer()!
    r.encodeFrame(cmd: cmd, target: rpd, width: lato, height: lato)
    cmd.commit(); cmd.waitUntilCompleted()
    RunLoop.main.run(until: Date().addingTimeInterval(1.0 / 30))
}
var dati = [Float16](repeating: 0, count: lato * lato * 4)
tex.getBytes(&dati, bytesPerRow: lato * 8, from: MTLRegionMake2D(0, 0, lato, lato), mipmapLevel: 0)
// toni: esposizione e curva di Reinhard col bianco a w, sui colori premoltiplicati
let esp = Float(a.count > 7 ? a[7] : "1")!, w: Float = 2.2
for i in stride(from: 0, to: dati.count, by: 4) {
    for c in 0..<3 {
        let v = max(0, Float(dati[i + c]) * esp)
        dati[i + c] = Float16(v * (1 + v / (w * w)) / (1 + v))
    }
}
let prov = CGDataProvider(data: Data(bytes: dati, count: dati.count * 2) as CFData)!
let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder16Little.rawValue)
let hdr = CGImage(width: lato, height: lato, bitsPerComponent: 16, bitsPerPixel: 64, bytesPerRow: lato * 8,
                  space: CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)!, bitmapInfo: info, provider: prov,
                  decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
let ctx = CGContext(data: nil, width: lato, height: lato, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.displayP3)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(hdr, in: CGRect(x: 0, y: 0, width: lato, height: lato))
let out = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: uscita) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, out, nil); CGImageDestinationFinalize(dest)
print("scritto", uscita, "noise ricco:", r.hasRichNoise)
