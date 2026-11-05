'use strict';
// game.js — игровой движок: потребности (симсовский реализм), инвентарь, память персонажей
const { q } = require('./db');

// потребности и скорость проседания в час (только при включённом реализме)
const NEEDS = [
  ['energy', 'Энергия', 3],
  ['food', 'Сытость', 4],
  ['hygiene', 'Гигиена', 2],
  ['mood', 'Настроение', 1],
];

function computeNeeds(persona) {
  let raw = {};
  try { raw = JSON.parse(persona.needs || '{}'); } catch {}
  const out = {};
  const nowT = Date.now();
  for (const [key] of NEEDS) {
    const rec = raw[key] || { v: 80, at: nowT };
    let v = rec.v;
    if (persona.realism) {
      const rate = NEEDS.find(n => n[0] === key)[2];
      v = v - ((nowT - (rec.at || nowT)) / 3600000) * rate;
    }
    out[key] = Math.round(Math.max(5, Math.min(100, v)));
  }
  return out;
}

function parseMemory(persona) {
  try { const m = JSON.parse(persona.memory || '[]'); return Array.isArray(m) ? m : []; } catch { return []; }
}

// блок состояния персонажей для контекста ИИ (по персонажам из последних постов)
function personaStateBlock(posts) {
  const ids = [...new Set(posts.slice(-12).map(p => p.persona_id).filter(Boolean))];
  if (!ids.length) return '';
  const lines = [];
  for (const id of ids) {
    const p = q.personaById.get(id);
    if (!p || p.deleted) continue;
    const parts = [];
    if (p.bio) parts.push(p.bio);
    const eq = q.equippedByPersona.all(id);
    const clothes = eq.filter(i => i.kind === 'одежда').map(i => i.name);
    const cars = eq.filter(i => i.kind === 'транспорт').map(i => i.name);
    const stuff = eq.filter(i => i.kind === 'вещь').map(i => i.name);
    if (clothes.length) parts.push(`одет(а): ${clothes.join(', ')}`);
    if (cars.length) parts.push(`транспорт: ${cars.join(', ')}`);
    if (stuff.length) parts.push(`при себе: ${stuff.join(', ')}`);
    if (p.realism) {
      const n = computeNeeds(p);
      parts.push(`состояние: ${NEEDS.map(([k, label]) => `${label.toLowerCase()} ${n[k]}/100`).join(', ')} (ниже 30 — персонаж это заметно чувствует)`);
    }
    const mem = parseMemory(p).slice(-15);
    if (mem.length) parts.push(`помнит: ${mem.join('; ')}`);
    if (parts.length) lines.push(`## ${p.name}\n${parts.join('. ')}`);
  }
  return lines.length ? lines.join('\n\n').slice(0, 6000) : '';
}

module.exports = { NEEDS, computeNeeds, parseMemory, personaStateBlock };
