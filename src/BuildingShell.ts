export type ShellCell = { x: number; y: number; z: number; w: number; h: number; d: number; role: 'wall' | 'floor' | 'partition' }

/** Sparse, shared layout for visible shell pieces and their matching physics shapes. */
export function buildingShell(w: number, h: number, d: number, includeBase = false): ShellCell[] {
  const t = .24, slab = .16, bottom = -h / 2
  const cells: ShellCell[] = []
  const add = (x: number, y: number, z: number, width: number, height: number, depth: number, role: ShellCell['role']) => {
    if (width > 0 && height > 0 && depth > 0) cells.push({ x, y, z, w: width, h: height, d: depth, role })
  }
  for (const side of [-1, 1]) {
    add(side * (w - t) / 2, 0, 0, t, h, d, 'wall')
    add(0, 0, side * (d - t) / 2, w - t * 2, h, t, 'wall')
  }
  const floors = Math.max(1, Math.round((h - .6) / 2.9))
  for (let floor = 0; floor < floors; floor++) {
    const level = bottom + floor * 2.9
    // Ground-level rooms use the shared terrain. Elevated volumes still need a base slab.
    const floorThickness = floor > 0 || includeBase ? slab : 0
    if (floorThickness) add(0, level + slab / 2, 0, w - t * 2, slab, d - t * 2, 'floor')
    const roomHeight = (floor === floors - 1 ? h - floor * 2.9 : 2.9) - floorThickness
    const door = 1.5, doorHeight = Math.min(2.15, roomHeight), segment = (d - t * 2 - door) / 2
    for (const side of [-1, 1]) add(0, level + floorThickness + roomHeight / 2,
      side * (door + segment) / 2, t, roomHeight, segment, 'partition')
    add(0, level + floorThickness + doorHeight + (roomHeight - doorHeight) / 2, 0,
      t, roomHeight - doorHeight, door, 'partition')
  }
  add(0, h / 2 - slab / 2, 0, w - t * 2, slab, d - t * 2, 'floor')
  return cells
}
