/**
 * Custom Codama builder for the Ika System program.
 *
 * Applies program-specific transformations to the raw Codama AST
 * before rendering to Rust/TypeScript clients.
 */

import { type Codama, createFromJson } from "codama";

export class IkaSystemCodamaBuilder {
  private codama: Codama;

  constructor(idlJson: unknown) {
    const jsonStr =
      typeof idlJson === "string" ? idlJson : JSON.stringify(idlJson);
    this.codama = createFromJson(jsonStr);
  }

  /** Add discriminator fields to account type definitions. */
  appendAccountDiscriminator(): this {
    // TODO: Add discriminator prefix to generated account types
    return this;
  }

  /** Add PDA derivation helpers based on seed definitions. */
  appendPdaDerivers(): this {
    // TODO: Add PDA derivers for SystemState, Validator, ValidatorList, NetworkAuthority
    return this;
  }

  /** Set default program ID for instruction accounts. */
  setInstructionAccountDefaultValues(): this {
    // TODO: Set default system_program, token_program IDs
    return this;
  }

  /** Mark bump arguments with proper PDA bump semantics. */
  updateInstructionBumps(): this {
    // TODO: Wire bump args to PDA derivation
    return this;
  }

  build(): Codama {
    return this.codama;
  }
}

export function createIkaSystemCodamaBuilder(
  idlJson: unknown,
): IkaSystemCodamaBuilder {
  return new IkaSystemCodamaBuilder(idlJson);
}
