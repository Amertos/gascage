/**
 * The v0.2 instruction set. 12 conceptual families; the arithmetic family is
 * split per type so the dispatch loop has no inner switch and the gas table in
 * docs/spec-v0.1.md §9 maps one-to-one onto an opcode.
 */
export const Op = {
  /** Block entry: where gas is charged. Costs 0 by itself; see METERING below. */
  ENTER: 0,
  CONST: 1,
  LOADLOC: 2,
  STORELOC: 3,
  FADD: 4,
  FSUB: 5,
  FMUL: 6,
  FDIV: 7,
  IDIV: 8,
  IMOD: 9,
  ILT: 10,
  ILE: 11,
  IGT: 12,
  IGE: 13,
  IEQ: 14,
  INE: 15,
  JMP: 16,
  JZ: 17,
  CALL: 18,
  RET: 19,
  HALT: 20,
  ARRAY_NEW: 21,
  ARRAY_GET: 22,
  ARRAY_SET: 23,
  CAST: 24,
  SQRT: 25,
  FABS: 26,
  FMIN: 27,
  FMAX: 28,
  /** Integer add/sub/mul with an immediate width mode: 32 or 64. */
  IADD: 29,
  ISUB: 30,
  IMUL: 31,
  /** Discard the top of the stack (expression statements). */
  POP: 32,
} as const;

export type OpCode = (typeof Op)[keyof typeof Op];

/** Cast target codes. */
export const CastTo = { I32: 0, I64: 1, F64: 2 } as const;

/**
 * Base gas costs, verbatim from spec §9. ARRAY_NEW is the only dynamic one
 * (2 + N elements) and is handled by instructionCost().
 */
export const GAS_COST: Record<OpCode, number> = {
  [Op.ENTER]: 0,
  [Op.CONST]: 1,
  [Op.LOADLOC]: 1,
  [Op.STORELOC]: 1,
  [Op.FADD]: 1,
  [Op.FSUB]: 1,
  [Op.FMUL]: 1,
  [Op.FDIV]: 2,
  [Op.IDIV]: 3,
  [Op.IMOD]: 3,
  [Op.ILT]: 1,
  [Op.ILE]: 1,
  [Op.IGT]: 1,
  [Op.IGE]: 1,
  [Op.IEQ]: 1,
  [Op.INE]: 1,
  [Op.JMP]: 1,
  [Op.JZ]: 1,
  [Op.CALL]: 5,
  [Op.RET]: 3,
  [Op.HALT]: 1,
  [Op.ARRAY_NEW]: 2,
  [Op.ARRAY_GET]: 3,
  [Op.ARRAY_SET]: 3,
  [Op.CAST]: 1,
  [Op.SQRT]: 8,
  [Op.FABS]: 2,
  [Op.FMIN]: 2,
  [Op.FMAX]: 2,
  [Op.IADD]: 1,
  [Op.ISUB]: 1,
  [Op.IMUL]: 1,
  [Op.POP]: 1,
};

export function instructionCost(op: OpCode, imm: number | undefined): number {
  if (op === Op.ARRAY_NEW) return 2 + (imm ?? 0);
  return GAS_COST[op];
}
