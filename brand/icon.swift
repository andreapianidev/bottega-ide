// Genera l'icona della Bottega (1024x1024). Uso: swift icon.swift out.png [--ios]
// Con --ios: la stessa scena a tutta pagina, senza trasparenza, ombra e bordo: gli angoli li ritaglia iOS.
// Il soggetto: la bottega di un artigiano del software, di notte. Una lampada da banco accesa, il suo cono
// di luce sul banco, un portatile con il codice e un martello accanto; fuori, poche stelle.
import AppKit

let S: CGFloat = 1024
let ios = CommandLine.arguments.contains("--ios")
let out = CommandLine.arguments.dropFirst().first { $0 != "--ios" } ?? "icon-1024.png"
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: (ios ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast).rawValue)!
func c(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}

// Griglia macOS: 824 pt di forma dentro 1024, angolo ~185.
let inset: CGFloat = 100
let rect = CGRect(x: inset, y: inset, width: S - 2 * inset, height: S - 2 * inset)
let shape = ios ? CGPath(rect: rect, transform: nil) : CGPath(roundedRect: rect, cornerWidth: 185, cornerHeight: 185, transform: nil)
if ios {
    // il quadrato della forma allargato a tutta la tela
    ctx.scaleBy(x: S / rect.width, y: S / rect.height)
    ctx.translateBy(x: -inset, y: -inset)
}

// Ombra sotto la forma
if !ios {
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 36, color: c(0x000000, 0.45))
    ctx.addPath(shape); ctx.setFillColor(c(0x0c1222)); ctx.fillPath()
    ctx.restoreGState()
}

ctx.saveGState()
ctx.addPath(shape); ctx.clip()

// La stanza di notte: blu in alto, quasi nero in basso
let room = CGGradient(colorsSpace: cs, colors: [c(0x24335a), c(0x141c33), c(0x0b1120)] as CFArray, locations: [0, 0.5, 1])!
ctx.drawLinearGradient(room, start: CGPoint(x: 0, y: rect.maxY), end: CGPoint(x: 0, y: rect.minY), options: [])

// Poche stelle, fuori dalla finestra
let stars: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(232, 790, 4.5, 0.85), (318, 700, 3, 0.6), (790, 800, 4, 0.8), (720, 712, 2.6, 0.55), (262, 610, 2.4, 0.45), (806, 640, 3, 0.6)]
for (x, y, r, a) in stars {
    ctx.setFillColor(c(0xe8e2d0, a)); ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
}

let bench: CGFloat = 352          // il piano del banco
let lampY: CGFloat = 664          // bordo inferiore del paralume

// Cono di luce dalla lampada al banco
let cone = CGMutablePath()
cone.move(to: CGPoint(x: 400, y: lampY))
cone.addLine(to: CGPoint(x: 624, y: lampY))
cone.addLine(to: CGPoint(x: 846, y: bench))
cone.addLine(to: CGPoint(x: 178, y: bench))
cone.closeSubpath()
ctx.saveGState()
ctx.addPath(cone); ctx.clip()
let beam = CGGradient(colorsSpace: cs, colors: [c(0xf4ab3c, 0.42), c(0xf4ab3c, 0.16), c(0xf4ab3c, 0.05)] as CFArray, locations: [0, 0.55, 1])!
ctx.drawLinearGradient(beam, start: CGPoint(x: 0, y: lampY), end: CGPoint(x: 0, y: bench), options: [])
ctx.restoreGState()

// Alone della lampadina
let bulb = CGPoint(x: 512, y: lampY - 6)
let glow = CGGradient(colorsSpace: cs, colors: [c(0xffd790, 0.9), c(0xf4ab3c, 0.35), c(0xf4ab3c, 0)] as CFArray, locations: [0, 0.35, 1])!
ctx.drawRadialGradient(glow, startCenter: bulb, startRadius: 0, endCenter: bulb, endRadius: 150, options: [])

// Filo e paralume conico
ctx.setStrokeColor(c(0x05080f)); ctx.setLineWidth(10)
ctx.move(to: CGPoint(x: 512, y: rect.maxY)); ctx.addLine(to: CGPoint(x: 512, y: lampY + 112)); ctx.strokePath()
let shade = CGMutablePath()
shade.move(to: CGPoint(x: 476, y: lampY + 112))
shade.addLine(to: CGPoint(x: 548, y: lampY + 112))
shade.addLine(to: CGPoint(x: 630, y: lampY))
shade.addLine(to: CGPoint(x: 394, y: lampY))
shade.closeSubpath()
ctx.addPath(shade); ctx.setFillColor(c(0x070b16)); ctx.fillPath()
// bordo del paralume illuminato da sotto
ctx.setStrokeColor(c(0xf4ab3c, 0.9)); ctx.setLineWidth(7)
ctx.move(to: CGPoint(x: 394, y: lampY + 2)); ctx.addLine(to: CGPoint(x: 630, y: lampY + 2)); ctx.strokePath()

// Il banco: legno scuro, il bordo acceso dove arriva la luce
ctx.setFillColor(c(0x0a0f1d)); ctx.fill(CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: bench - rect.minY))
// riflesso della lampada sul fronte del banco e le assi del legno
let pool = CGGradient(colorsSpace: cs, colors: [c(0xf4ab3c, 0.16), c(0xf4ab3c, 0)] as CFArray, locations: [0, 1])!
ctx.saveGState()
ctx.clip(to: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: bench - rect.minY))
ctx.drawRadialGradient(pool, startCenter: CGPoint(x: 512, y: bench), startRadius: 0, endCenter: CGPoint(x: 512, y: bench), endRadius: 300, options: [])
ctx.restoreGState()
ctx.setFillColor(c(0x000000, 0.35))
for y in [bench - 86, bench - 172] { ctx.fill(CGRect(x: rect.minX, y: y, width: rect.width, height: 4)) }
ctx.setFillColor(c(0xf4ab3c, 0.07))
for y in [bench - 82, bench - 168] { ctx.fill(CGRect(x: 260, y: y, width: 504, height: 2)) }
let edge = CGGradient(colorsSpace: cs, colors: [c(0xf4ab3c, 0), c(0xf4ab3c, 0.85), c(0xf4ab3c, 0)] as CFArray, locations: [0, 0.5, 1])!
ctx.saveGState()
ctx.clip(to: CGRect(x: rect.minX, y: bench - 5, width: rect.width, height: 10))
ctx.drawLinearGradient(edge, start: CGPoint(x: 150, y: 0), end: CGPoint(x: 874, y: 0), options: [])
ctx.restoreGState()

// Il portatile aperto, con il codice sullo schermo
let lid = CGRect(x: 392, y: bench + 22, width: 220, height: 150)
ctx.addPath(CGPath(roundedRect: lid, cornerWidth: 14, cornerHeight: 14, transform: nil))
ctx.setFillColor(c(0x0b1120)); ctx.fillPath()
let screen = lid.insetBy(dx: 12, dy: 12)
let lit = CGGradient(colorsSpace: cs, colors: [c(0x1b2744), c(0x111a30)] as CFArray, locations: [0, 1])!
ctx.saveGState()
ctx.addPath(CGPath(roundedRect: screen, cornerWidth: 6, cornerHeight: 6, transform: nil)); ctx.clip()
ctx.drawLinearGradient(lit, start: CGPoint(x: 0, y: screen.maxY), end: CGPoint(x: 0, y: screen.minY), options: [])
ctx.restoreGState()
// "</>" in ambra
ctx.setStrokeColor(c(0xffc46b)); ctx.setLineWidth(13); ctx.setLineCap(.round); ctx.setLineJoin(.round)
let mid = CGPoint(x: screen.midX, y: screen.midY)
ctx.move(to: CGPoint(x: mid.x - 44, y: mid.y + 34)); ctx.addLine(to: CGPoint(x: mid.x - 78, y: mid.y)); ctx.addLine(to: CGPoint(x: mid.x - 44, y: mid.y - 34))
ctx.move(to: CGPoint(x: mid.x + 44, y: mid.y + 34)); ctx.addLine(to: CGPoint(x: mid.x + 78, y: mid.y)); ctx.addLine(to: CGPoint(x: mid.x + 44, y: mid.y - 34))
ctx.move(to: CGPoint(x: mid.x + 16, y: mid.y + 40)); ctx.addLine(to: CGPoint(x: mid.x - 16, y: mid.y - 40))
ctx.strokePath()
// base del portatile, appoggiata sul banco
ctx.addPath(CGPath(roundedRect: CGRect(x: 372, y: bench, width: 260, height: 22), cornerWidth: 8, cornerHeight: 8, transform: nil))
ctx.setFillColor(c(0x1a2238)); ctx.fillPath()
ctx.setFillColor(c(0xf4ab3c, 0.55)); ctx.fill(CGRect(x: 380, y: bench + 18, width: 244, height: 3))

// Il martello, appoggiato accanto: l'artigiano
ctx.saveGState()
ctx.translateBy(x: 712, y: bench + 24)
ctx.rotate(by: 0.1)
ctx.addPath(CGPath(roundedRect: CGRect(x: -6, y: -8, width: 128, height: 16), cornerWidth: 8, cornerHeight: 8, transform: nil))
ctx.setFillColor(c(0x3a2a18)); ctx.fillPath()
ctx.addPath(CGPath(roundedRect: CGRect(x: -26, y: -22, width: 36, height: 50), cornerWidth: 6, cornerHeight: 6, transform: nil))
ctx.setFillColor(c(0x2a3350)); ctx.fillPath()
ctx.setFillColor(c(0xf4ab3c, 0.6)); ctx.fill(CGRect(x: -26, y: 22, width: 36, height: 4))
ctx.restoreGState()

// Bordo interno sottile, come il vetro delle icone di macOS 27
ctx.restoreGState()
if !ios { ctx.addPath(shape); ctx.setStrokeColor(c(0xffffff, 0.10)); ctx.setLineWidth(3); ctx.strokePath() }

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("ok", out)
