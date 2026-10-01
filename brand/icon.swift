// Genera l'icona della Bottega (1024x1024). Uso: swift icon.swift out.png
import AppKit

let S: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
func c(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}

// Griglia macOS: 824 pt di forma dentro 1024, angolo ~185.
let inset: CGFloat = 100
let rect = CGRect(x: inset, y: inset, width: S - 2 * inset, height: S - 2 * inset)
let shape = CGPath(roundedRect: rect, cornerWidth: 185, cornerHeight: 185, transform: nil)

// Ombra sotto la forma
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 36, color: c(0x000000, 0.45))
ctx.addPath(shape); ctx.setFillColor(c(0x0c1222)); ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape); ctx.clip()
// Cielo: dal blu notte in alto al quasi nero sull'orizzonte
let sky = CGGradient(colorsSpace: cs, colors: [c(0x24335a), c(0x121a2e), c(0x0b1120)] as CFArray, locations: [0, 0.55, 1])!
ctx.drawLinearGradient(sky, start: CGPoint(x: 0, y: rect.maxY), end: CGPoint(x: 0, y: rect.minY), options: [])

// Stelle
let stars: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(250, 800, 5, 0.9), (330, 690, 3.2, 0.7), (770, 820, 4, 0.8), (690, 735, 2.6, 0.6), (420, 860, 2.4, 0.55), (820, 640, 3, 0.65), (205, 615, 2.4, 0.5), (585, 880, 3, 0.7)]
for (x, y, r, a) in stars {
    ctx.setFillColor(c(0xe8e2d0, a)); ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
}

// Lampada al sodio: alone e disco
let lamp = CGPoint(x: 512, y: 560)
let glow = CGGradient(colorsSpace: cs, colors: [c(0xf4ab3c, 0.55), c(0xf4ab3c, 0.12), c(0xf4ab3c, 0)] as CFArray, locations: [0, 0.45, 1])!
ctx.drawRadialGradient(glow, startCenter: lamp, startRadius: 0, endCenter: lamp, endRadius: 330, options: [])
let disc = CGGradient(colorsSpace: cs, colors: [c(0xffd790), c(0xf4ab3c), c(0xd9861a)] as CFArray, locations: [0, 0.6, 1])!
ctx.saveGState()
ctx.addEllipse(in: CGRect(x: lamp.x - 118, y: lamp.y - 118, width: 236, height: 236)); ctx.clip()
ctx.drawRadialGradient(disc, startCenter: CGPoint(x: lamp.x - 30, y: lamp.y + 36), startRadius: 0, endCenter: lamp, endRadius: 130, options: [])
ctx.restoreGState()

// Profilo della caldera con la cupola dell'osservatorio
let ridge = CGMutablePath()
ridge.move(to: CGPoint(x: rect.minX, y: 300))
ridge.addCurve(to: CGPoint(x: 380, y: 420), control1: CGPoint(x: 210, y: 330), control2: CGPoint(x: 300, y: 410))
ridge.addLine(to: CGPoint(x: 470, y: 452))
ridge.addLine(to: CGPoint(x: 600, y: 452))
ridge.addCurve(to: CGPoint(x: rect.maxX, y: 330), control1: CGPoint(x: 720, y: 440), control2: CGPoint(x: 830, y: 360))
ridge.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
ridge.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
ridge.closeSubpath()
// cupola dell'osservatorio, con la fessura aperta verso il cielo
ctx.addPath(ridge); ctx.setFillColor(c(0x070b16)); ctx.fillPath()
let dome = CGMutablePath()
dome.addRect(CGRect(x: 478, y: 440, width: 116, height: 32))
dome.addArc(center: CGPoint(x: 536, y: 472), radius: 58, startAngle: 0, endAngle: .pi, clockwise: false)
ctx.addPath(dome); ctx.fillPath()
ctx.setFillColor(c(0xf4ab3c, 0.85))
ctx.fill(CGRect(x: 530, y: 486, width: 12, height: 42))

// Bordo interno sottile, come il vetro delle icone di macOS 27
ctx.restoreGState()
ctx.addPath(shape); ctx.setStrokeColor(c(0xffffff, 0.10)); ctx.setLineWidth(3); ctx.strokePath()

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("ok", out)
