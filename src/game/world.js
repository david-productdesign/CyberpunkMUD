// The static half of the world: rooms and item prototypes. Both are seeded and
// read-mostly, so we load them into memory once at boot and never query again.

export const START_ROOM = 's7-alley';

export function loadWorld(db) {
  const rooms = new Map();
  for (const row of db.prepare('SELECT * FROM rooms').all()) {
    rooms.set(row.id, {
      id: row.id,
      area: row.area,
      name: row.name,
      description: row.description,
      exits: JSON.parse(row.exits || '{}'),
    });
  }

  const protos = new Map();
  for (const row of db.prepare('SELECT * FROM item_protos').all()) {
    protos.set(row.id, {
      id: row.id,
      name: row.name,
      keywords: row.keywords.split(/\s+/).filter(Boolean),
      roomDesc: row.room_desc,
      description: row.description,
      portable: row.portable === 1,
    });
  }

  return { rooms, protos };
}
