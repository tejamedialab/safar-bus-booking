/**
 * Generates a seat grid from a simple description such as "2+1 sleeper, 2 decks, 5 rows".
 * Columns: [left seats][aisle][right seats]; the aisle column is left empty.
 */
export interface LayoutSpec {
  seatType: 'SEATER' | 'SLEEPER';
  configuration: '1+1' | '2+1' | '2+2';
  rows: number;
  decks: 1 | 2;
  lowerDeckFareFactor?: number; // sleepers: lower berths are usually priced higher
}

export interface GeneratedSeat {
  label: string;
  deck: 1 | 2;
  gridRow: number;
  gridCol: number;
  seatType: 'SEATER' | 'SLEEPER';
  isWindow: boolean;
  fareFactor: number;
}

export function generateLayout(spec: LayoutSpec): { gridCols: number; seats: GeneratedSeat[] } {
  const [left, right] = spec.configuration.split('+').map(Number);
  const gridCols = left + 1 + right;
  const aisle = left;
  const seats: GeneratedSeat[] = [];
  for (let deck = 1 as 1 | 2; deck <= spec.decks; deck = (deck + 1) as 1 | 2) {
    let n = 0;
    for (let row = 0; row < spec.rows; row++) {
      for (let col = 0; col < gridCols; col++) {
        if (col === aisle) continue;
        n++;
        const prefix = spec.seatType === 'SLEEPER' ? (deck === 1 ? 'L' : 'U') : '';
        const number = spec.seatType === 'SLEEPER' ? n : seats.length + 1;
        seats.push({
          label: `${prefix}${number}`,
          deck,
          gridRow: row,
          gridCol: col,
          seatType: spec.seatType,
          isWindow: col === 0 || col === gridCols - 1,
          fareFactor: spec.seatType === 'SLEEPER' && deck === 1 ? spec.lowerDeckFareFactor ?? 1 : 1,
        });
      }
    }
  }
  return { gridCols, seats };
}
