export const HELL_VM_FAULTS = {
  none: 0, stackUnderflow: 1, stackOverflow: 2, invalidOutput: 3, fellOffProgram: 4,
  returnStackUnderflow: 5, returnStackOverflow: 6, divisionByZero: 7, invalidInput: 8,
} as const;
