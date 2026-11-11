export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class UnsupportedCurrencyError extends EngineInputError {}
export class EngineInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
