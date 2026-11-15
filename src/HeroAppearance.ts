import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { acquireHeroTextures } from './HeroTextures'

type HeroPart = { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> }

// Costume pieces live under the physical limbs, so every detail follows both
// the animated joints and the dynamic ragdoll without a second skeleton.
export function addHeroAppearance(parts: ReadonlyMap<string, HeroPart>, invalidate = () => {}) {
  const { textures, dispose } = acquireHeroTextures(invalidate)
  const material = (color: string, roughness = .6, metalness = .02) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness })
  const blue = new THREE.MeshPhysicalMaterial({ color: '#24478c', roughness: .91, metalness: 0,
    map: textures.suitColor, normalMap: textures.suitNormal, normalScale: new THREE.Vector2(.32, .32),
    roughnessMap: textures.suitRoughness, sheen: .32, sheenColor: '#7798cb', sheenRoughness: .85 })
  const seam = material('#183d91', .8)
  const red = new THREE.MeshPhysicalMaterial({ color: '#9c2431', roughness: .65,
    map: textures.suitColor, normalMap: textures.suitNormal, normalScale: new THREE.Vector2(.18, .18),
    roughnessMap: textures.suitRoughness, clearcoat: .13, clearcoatRoughness: .6 })
  const redDark = material('#871728', .65)
  const capeRed = new THREE.MeshPhysicalMaterial({ color: '#b51e2b', roughness: .88,
    sheen: 1, sheenColor: '#df5550', sheenRoughness: .78, side: THREE.DoubleSide })
  const gold = material('#f5bd43', .3, .65)
  const goldLight = material('#ffe19a', .28, .5)
  const skin = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: .88,
    map: textures.skinColor, bumpMap: textures.skinDetail, bumpScale: .0018,
    roughnessMap: textures.skinDetail, clearcoat: .06, clearcoatRoughness: .7 })
  const skinShadow = skin.clone()
  skinShadow.color.set('#c99281')
  const eyebrow = material('#241e22', .64)
  const white = new THREE.MeshPhysicalMaterial({ color: '#e6dfd4', roughness: .24, clearcoat: 1, clearcoatRoughness: .12 })
  const iris = material('#347caa', .32)
  const pupil = material('#111b28', .3)
  const lip = material('#a45b4e', .8)
  const sphere = new THREE.SphereGeometry(1, 24, 18)
  const add = (id: string, geometry: THREE.BufferGeometry, mat: THREE.Material,
    x = 0, y = 0, z = 0, name = '') => {
    const mesh = new THREE.Mesh(geometry, mat)
    mesh.position.set(x, y, z)
    mesh.name = name
    mesh.castShadow = mesh.receiveShadow = true
    parts.get(id)!.mesh.add(mesh)
    return mesh
  }
  const ellipsoid = (id: string, mat: THREE.Material, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, name = '') => {
    const mesh = add(id, sphere, mat, x, y, z, name)
    mesh.scale.set(sx, sy, sz)
    return mesh
  }
  const line = (id: string, mat: THREE.Material, points: number[][], radius: number, name = '') => {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
    return add(id, new THREE.TubeGeometry(curve, Math.max(12, points.length * 5), radius, 6, false), mat, 0, 0, 0, name)
  }
  const panel = (id: string, mat: THREE.Material, outline: number[][], z: number, name: string) => {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)))
    return add(id, new THREE.ExtrudeGeometry(shape, {
      depth: .005, bevelEnabled: true, bevelThickness: .002, bevelSize: .002, bevelSegments: 2,
    }), mat, 0, 0, z, name)
  }
  const replace = (id: string, geometry: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial) => {
    const mesh = parts.get(id)!.mesh
    mesh.geometry.dispose()
    mesh.material.dispose()
    mesh.geometry = geometry
    mesh.material = mat
  }
  // Match the visible sockets and hands to the same PBR materials as the limbs.
  for (const [id, part] of parts) {
    if (id.endsWith('Shoulder') || id.endsWith('Hand') || id.endsWith('Ankle')) {
      part.mesh.material.dispose()
      part.mesh.material = id.endsWith('Hand') ? skin : id.endsWith('Ankle') ? red : blue
    }
  }
  // Smooth, tapered superhero anatomy rather than rectangular armor plates.
  const torso = (id: string, profile: number[][], depth: number) => {
    const curve = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r, y)))
    const geometry = new THREE.LatheGeometry(curve.getPoints(48).map(p => new THREE.Vector2(Math.max(0, p.x), p.y)), 40)
    geometry.scale(1, 1, depth)
    const positions = geometry.getAttribute('position')
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i)
      if (z <= 0) continue
      const bulge = id === 'chest' ? .018 * Math.exp(-(((Math.abs(x) - .14) / .13) ** 2) - ((y - .04) / .12) ** 2)
        : id === 'abdomen' ? .006 * Math.exp(-(((Math.abs(x) - .065) / .055) ** 2)) * (1 + Math.cos(y * 58)) : 0
      positions.setZ(i, z + bulge * Math.min(1, z / .06))
    }
    geometry.computeVertexNormals()
    replace(id, geometry, blue)
  }
  torso('chest', [[0, -.23], [.21, -.225], [.25, -.16], [.32, -.01], [.34, .10], [.29, .18], [.15, .225], [0, .225]], .58)
  torso('abdomen', [[0, -.18], [.21, -.18], [.22, -.1], [.22, .06], [.24, .17], [0, .17]], .66)
  torso('pelvis', [[0, -.20], [.13, -.20], [.23, -.11], [.265, .04], [.24, .17], [0, .17]], .64)
  const head = new RoundedBoxGeometry(.34, .405, .32, 14, .13)
  const face = head.getAttribute('position')
  const gaussian = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
    Math.exp(-(((x - cx) / rx) ** 2) - ((y - cy) / ry) ** 2)
  for (let i = 0; i < face.count; i++) {
    const x = face.getX(i), y = face.getY(i), z = face.getZ(i)
    // Taper the jaw, recess the sockets and shape cheekbones/brow/chin.
    const jaw = 1 - .12 * (1 - THREE.MathUtils.smoothstep(y, -.19, -.055))
    const front = THREE.MathUtils.smoothstep(z, .065, .14)
    let depth = .009 * gaussian(x, y, 0, -.145, .07, .04)
    for (const sign of [-1, 1]) {
      depth -= .012 * gaussian(x, y, sign * .073, .025, .038, .023)
      depth += .010 * gaussian(x, y, sign * .095, -.025, .048, .032)
      depth += .007 * gaussian(x, y, sign * .070, .060, .049, .019)
    }
    face.setXYZ(i, x * jaw, y, z + front * depth)
  }
  // RoundedBox is non-indexed. Weld a position-only copy for smooth sculpted
  // normals, then copy them back without disturbing the original UV seams.
  const weldedHead = mergeVertices(head.clone().deleteAttribute('normal').deleteAttribute('uv'))
  weldedHead.computeVertexNormals()
  const headNormals = head.getAttribute('normal')
  const smoothNormals = weldedHead.getAttribute('normal')
  const headIndices = weldedHead.getIndex()!
  for (let i = 0; i < face.count; i++) {
    const index = headIndices.getX(i)
    headNormals.setXYZ(i, smoothNormals.getX(index), smoothNormals.getY(index), smoothNormals.getZ(index))
  }
  weldedHead.dispose()
  replace('head', head, skin)
  replace('neck', new THREE.CapsuleGeometry(.083, .11, 6, 20), skin)
  const muscle = (id: string, length: number, radius: number, slope: number, mat: THREE.MeshStandardMaterial) => {
    const profile = Array.from({ length: 33 }, (_, i) => {
      const t = i / 32
      return new THREE.Vector2(radius * Math.sin(Math.PI * t) ** .40 * (1 + .08 * Math.sin(t * Math.PI * 2)),
        (t - .5) * (length + .12))
    })
    const geometry = new THREE.LatheGeometry(profile, 28)
    geometry.scale(1, 1, .90)
    geometry.rotateZ(slope)
    replace(id, geometry, mat)
  }
  for (const sign of [-1, 1]) {
    const side = sign < 0 ? 'right' : 'left'
    line('abdomen', gold, [[sign * .207, .15, .06], [sign * .175, .08, .10],
      [sign * .172, -.03, .10], [sign * .19, -.16, .09]], .009, 'gold-suit-piping')
    ellipsoid('head', skin, sign * .172, -.012, -.008, .027, .058, .031, 'ear')
    ellipsoid('head', skinShadow, sign * .189, -.012, .010, .008, .034, .018, 'inner-ear')
    const eye = ellipsoid('head', white, sign * .073, .025, .147, .030, .012, .012, `${side}-eye`)
    eye.rotation.z = -sign * .06
    ellipsoid('head', iris, sign * .072, .025, .159, .009, .010, .003, 'iris')
    ellipsoid('head', pupil, sign * .072, .025, .162, .004, .006, .002, 'pupil')
    ellipsoid('head', white, sign * .072 - .003, .029, .164, .0017, .002, .001, 'eye-catchlight')
    line('head', skinShadow, [[sign * .038, .033, .156], [sign * .073, .044, .157],
      [sign * .103, .028, .150]], .0035, 'upper-eyelid')
    line('head', skin, [[sign * .043, .022, .153], [sign * .073, .014, .156],
      [sign * .102, .023, .149]], .003, 'lower-eyelid')
    line('head', eyebrow, [[sign * .025, .064, .153], [sign * .065, .072, .153],
      [sign * .112, .056, .143]], .006, 'eyebrow')

    // Anatomical masses overlap the joint sockets while keeping the elbow,
    // wrist, knee and ankle pivots free to bend through their physical limits.
    muscle(`${side}UpperArm`, .47, .126, sign * .55, blue)
    muscle(`${side}Forearm`, .386, .095, sign * .37, blue)
    muscle(`${side}Thigh`, .456, .141, sign * .077, blue)
    muscle(`${side}Shin`, .451, .101, sign * .044, red)
    ellipsoid(`${side}UpperArm`, blue, sign * .117, -.19, 0, .086, .086, .086, 'elbow')
    ellipsoid(`${side}Thigh`, blue, sign * .0175, -.2275, 0, .096, .098, .093, 'knee')
    line(`${side}Forearm`, gold, [[-sign * .065, .05, .076], [0, .015, .091],
      [sign * .077, .048, .060]], .011, 'gold-cuff-chevron')
    ellipsoid(`${side}Hand`, skin, -sign * .057, -.015, .026, .031, .060, .040, 'thumb')
    for (let finger = 0; finger < 4; finger++) {
      const x = -.051 + finger * .034
      ellipsoid(`${side}Hand`, skin, x, -.061, .045, .019, .039, .029, 'finger-knuckle')
      ellipsoid(`${side}Hand`, skin, x, -.086, .018, .018, .025, .034, 'curled-finger')
    }
    line(`${side}Thigh`, seam, [[sign * .09, .17, .075], [sign * .108, -.01, .075],
      [sign * .065, -.17, .078]], .004, 'leg-seam')
    // Tall red boots with a peaked gold edge, shaped calf and separate sole.
    line(`${side}Shin`, gold, [[-.074, .15, .048], [-.045, .178, .060], [0, .211, .065],
      [.045, .178, .060], [.074, .15, .048]], .009, 'boot-gold-edge')
    line(`${side}Shin`, redDark, [[0, .20, .071], [0, .10, .095], [0, -.16, .073]], .003, 'boot-seam')
    replace(`${side}Foot`, new RoundedBoxGeometry(.21, .16, .40, 5, .065), red)
    add(`${side}Foot`, new RoundedBoxGeometry(.214, .026, .405, 3, .012), redDark, 0, -.078, 0, 'boot-sole')
    ellipsoid('chest', capeRed, sign * .287, .173, -.026, .14, .052, .19, 'cape-shoulder-fold')
    for (let fold = 0; fold < 3; fold++) {
      // Gather the fabric into the clasp, then fan it over each shoulder.
      line('chest', capeRed, [[sign * .258, .180 - fold * .009, .129],
        [sign * (.30 + fold * .027), .225 - fold * .012, .052],
        [sign * (.32 + fold * .041), .233 - fold * .019, -.065],
        [sign * (.285 + fold * .045), .181 - fold * .007, -.175]],
      .014 - fold * .002, 'cape-gathered-fold')
    }
    const clasp = add('chest', new THREE.CylinderGeometry(.057, .057, .021, 32), gold,
      sign * .255, .179, .138, 'cape-clasp')
    clasp.rotation.x = Math.PI / 2
    ellipsoid('chest', goldLight, sign * .255, .179, .153, .042, .042, .009, 'clasp-inset')
    add('chest', new THREE.TorusGeometry(.048, .0035, 8, 32), goldLight,
      sign * .255, .179, .152, 'clasp-raised-rim')
  }
  line('chest', capeRed, [[-.255, .180, .145], [-.16, .175, .174], [0, .166, .192],
    [.16, .175, .174], [.255, .180, .145]], .018, 'cape-draped-neckline')
  // A fabric band joins the raised neck edge to the sewn back of the cape.
  const collarPositions: number[] = [], collarIndices: number[] = []
  for (let column = 0; column <= 24; column++) {
    const across = column / 12 - 1
    const x = across * .30
    const lowerZ = -.065 - .16 * (1 - THREE.MathUtils.smoothstep(Math.abs(x) / .462, .58, .83))
    for (let row = 0; row <= 4; row++) {
      const t = row / 4
      collarPositions.push(x, THREE.MathUtils.lerp(.18, .225 + .02 * (1 - across ** 2), t),
        THREE.MathUtils.lerp(lowerZ, -.22 + .025 * across ** 2, t) - .008 * Math.sin(t * Math.PI))
      if (column < 24 && row < 4) {
        const index = column * 5 + row
        collarIndices.push(index, index + 1, index + 5, index + 1, index + 6, index + 5)
      }
    }
  }
  const collar = new THREE.BufferGeometry()
  collar.setAttribute('position', new THREE.Float32BufferAttribute(collarPositions, 3))
  collar.setIndex(collarIndices)
  collar.computeVertexNormals()
  add('chest', collar, capeRed, 0, 0, 0, 'cape-back-collar')
  line('chest', capeRed, [[-.30, .225, -.195], [-.16, .239, -.213], [0, .245, -.22],
    [.16, .239, -.213], [.30, .225, -.195]], .008, 'cape-collar-rolled-edge')
  // Raised wing/star insignia from the supplied Skyward concept sheet.
  panel('chest', gold, [[-.258, .063], [-.222, .083], [-.073, .056], [-.028, .041],
    [0, .154], [.032, .048], [.076, .033], [.231, .056], [.264, .033],
    [.103, .008], [.045, -.016], [0, -.150], [-.053, -.026], [-.117, .002],
    [-.195, .012], [-.222, .036], [-.093, .024], [-.026, -.001], [0, -.077],
    [.025, -.004], [.075, .026], [-.03, .024], [-.089, .044]], .216, 'skyward-emblem')
  panel('chest', goldLight, [[0, .133], [.018, .033], [.064, .022], [.023, .008],
    [0, -.064], [-.017, .017], [-.047, .032], [-.014, .032]], .225, 'emblem-highlight')
  add('pelvis', new RoundedBoxGeometry(.548, .077, .343, 3, .018), gold, 0, .111, 0, 'belt-gold-trim')
  add('pelvis', new RoundedBoxGeometry(.559, .053, .351, 3, .014), red, 0, .111, .001, 'red-belt')
  panel('pelvis', gold, [[-.066, .163], [.066, .163], [.047, .053], [-.047, .053]], .191, 'belt-buckle')
  panel('pelvis', red, [[-.040, .143], [.040, .143], [.029, .076], [-.029, .076]], .201, 'buckle-inset')
  ellipsoid('head', skin, 0, .004, .157, .015, .046, .022, 'nose-bridge')
  ellipsoid('head', skin, 0, -.025, .178, .023, .017, .024, 'nose')
  for (const sign of [-1, 1]) {
    ellipsoid('head', skin, sign * .020, -.032, .169, .012, .011, .014, 'nose-wing')
    ellipsoid('head', skinShadow, sign * .014, -.039, .178, .006, .003, .005, 'nostril')
  }
  line('head', lip, [[-.044, -.092, .151], [-.016, -.091, .161], [0, -.094, .164],
    [.016, -.091, .161], [.044, -.092, .151]], .0025, 'lip-line')
  const lowerLip = skin.clone(); lowerLip.color.set('#dba39b')
  ellipsoid('head', lowerLip, 0, -.101, .155, .033, .006, .009, 'lower-lip')
  return dispose
}
