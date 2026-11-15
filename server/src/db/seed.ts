/**
 * Demo seed. Everything after the base users is created THROUGH THE SERVICES (not raw SQL), so the
 * seed data obeys exactly the same rules, constraints and audit trail as real usage.
 * Only dummy data: fictional operators, example.com emails, fake phone numbers.
 */
import { randomUUID } from 'node:crypto';
import { getPool, query, queryOne } from './pool.js';
import type { Actor } from '../lib/http.js';
import { hashPassword } from '../modules/auth/auth.js';
import { createBooking, cancelBooking, transitionRefund } from '../modules/bookings/bookings.service.js';
import { createBus, createLayout, createOperator, createOperatorStaff } from '../modules/fleet/fleet.service.js';
import { createHold } from '../modules/inventory/inventory.service.js';
import { createRoute, createSchedule, generateTrips } from '../modules/network/network.service.js';

export const DEMO_PASSWORDS = {
  admin: 'Admin@12345',
  operator: 'Operator@12345',
  passenger: 'Passenger@12345',
};

const CITIES: [string, string][] = [
  ['Hyderabad', 'Telangana'], ['Suryapet', 'Telangana'], ['Warangal', 'Telangana'],
  ['Vijayawada', 'Andhra Pradesh'], ['Rajahmundry', 'Andhra Pradesh'], ['Visakhapatnam', 'Andhra Pradesh'],
  ['Kurnool', 'Andhra Pradesh'], ['Anantapur', 'Andhra Pradesh'], ['Tirupati', 'Andhra Pradesh'], ['Puttur', 'Andhra Pradesh'],
  ['Bengaluru', 'Karnataka'], ['Chennai', 'Tamil Nadu'], ['Tiruvallur', 'Tamil Nadu'],
  ['Delhi', 'Delhi'], ['Ambala', 'Haryana'], ['Ludhiana', 'Punjab'], ['Phagwara', 'Punjab'], ['Jalandhar', 'Punjab'], ['Amritsar', 'Punjab'],
];

const istDate = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
};

async function insertUser(email: string, fullName: string, role: string, password: string, operatorId: string | null = null, phone: string | null = null) {
  return queryOne<{ id: string; email: string; full_name: string; role: string; operator_id: string | null }>(
    `INSERT INTO users (email, password_hash, full_name, role, operator_id, phone) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, full_name, role, operator_id`,
    [email, await hashPassword(password), fullName, role, operatorId, phone],
  );
}

const asActor = (u: any): Actor => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name ?? u.fullName,
  role: u.role,
  operatorId: u.operator_id ?? u.operatorId ?? null,
  requestId: 'seed',
});

export async function seed(log: (m: string) => void = console.log) {
  const pool = getPool();
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) {
    log('Database already has data — run `npm run db:reset` for a clean re-seed.');
    return;
  }

  // ---------------------------------------------------------------- base data
  for (const [name, state] of CITIES) await query('INSERT INTO cities (name, state) VALUES ($1, $2)', [name, state]);
  const city = Object.fromEntries((await query('SELECT id, name FROM cities')).map((c: any) => [c.name, c.id]));

  const admin = asActor(await insertUser('admin@safar.dev', 'Safar Admin', 'ADMIN', DEMO_PASSWORDS.admin));

  const ops = {
    DS: await createOperator(admin, { name: 'Deccan Starliner', code: 'DS', contactEmail: 'ops@deccanstar.example.com', contactPhone: '9000000001' }),
    PH: await createOperator(admin, { name: 'Punjab Highway Coaches', code: 'PH', contactEmail: 'ops@punjabhighway.example.com', contactPhone: '9000000002' }),
    CC: await createOperator(admin, { name: 'Coromandel Coachways', code: 'CC', contactEmail: 'ops@coromandel.example.com', contactPhone: '9000000003' }),
  };
  const staff = {
    DS: asActor(await createOperatorStaff(admin, ops.DS.id, { fullName: 'Deccan Ops Manager', email: 'ops.deccan@safar.dev', password: DEMO_PASSWORDS.operator })),
    PH: asActor(await createOperatorStaff(admin, ops.PH.id, { fullName: 'Punjab Ops Manager', email: 'ops.punjab@safar.dev', password: DEMO_PASSWORDS.operator })),
    CC: asActor(await createOperatorStaff(admin, ops.CC.id, { fullName: 'Coromandel Ops Manager', email: 'ops.coromandel@safar.dev', password: DEMO_PASSWORDS.operator })),
  };

  // ---------------------------------------------------------------- fleet
  const sleeper = await createLayout(admin, { name: 'Sleeper 2+1 · 30 berths', seatType: 'SLEEPER', configuration: '2+1', rows: 5, decks: 2, lowerDeckFareFactor: 1.1 });
  const seater = await createLayout(admin, { name: 'Seater 2+2 · 40 seats', seatType: 'SEATER', configuration: '2+2', rows: 10, decks: 1 });
  const semi = await createLayout(admin, { name: 'Semi-sleeper 2+1 · 36 seats', seatType: 'SEATER', configuration: '2+1', rows: 12, decks: 1 });

  const bus = async (actor: Actor, reg: string, type: any, layoutId: string, amenities: string[]) =>
    (await createBus(actor, { registrationNo: reg, busType: type, seatLayoutId: layoutId, amenities })).id as string;
  const buses = {
    dsSleeper1: await bus(staff.DS, 'TS09UA4521', 'AC_SLEEPER', sleeper.id, ['AC', 'Charging point', 'Blanket', 'Water bottle', 'Reading light']),
    dsVolvo: await bus(staff.DS, 'TS10VB3344', 'VOLVO_MULTI_AXLE', seater.id, ['AC', 'Charging point', 'Wi-Fi', 'Water bottle']),
    dsSleeper2: await bus(staff.DS, 'AP39TC9090', 'AC_SLEEPER', sleeper.id, ['AC', 'Charging point', 'Blanket']),
    phSleeper: await bus(staff.PH, 'PB08CF1122', 'AC_SLEEPER', sleeper.id, ['AC', 'Blanket', 'Charging point', 'CCTV']),
    phSeater: await bus(staff.PH, 'PB10DL5566', 'AC_SEATER', seater.id, ['AC', 'Charging point']),
    ccSeater: await bus(staff.CC, 'TN01AK2233', 'NON_AC_SEATER', seater.id, ['Charging point']),
    ccSemi: await bus(staff.CC, 'TN02BX8899', 'AC_SEATER', semi.id, ['AC', 'Charging point', 'Water bottle']),
  };

  // ---------------------------------------------------------------- routes [city, point, arr, dep, km, ₹cumulative]
  const stops = (list: [string, string, number, number, number, number][]) =>
    list.map(([c, pointName, arrivalOffsetMin, departureOffsetMin, distanceKm, cumulativeFare]) => ({
      cityId: city[c], pointName, arrivalOffsetMin, departureOffsetMin, distanceKm, cumulativeFare,
    }));

  const hydVizag = await createRoute(staff.DS, {
    code: 'HYD-VSKP', name: 'Hyderabad → Visakhapatnam (via Vijayawada)',
    stops: stops([
      ['Hyderabad', 'Miyapur X Roads', 0, 0, 0, 0],
      ['Hyderabad', 'Ameerpet Metro', 35, 45, 18, 20],
      ['Hyderabad', 'LB Nagar Ring Road', 85, 95, 38, 40],
      ['Suryapet', 'Suryapet Bus Stand', 220, 230, 165, 380],
      ['Vijayawada', 'Benz Circle', 390, 405, 290, 650],
      ['Rajahmundry', 'Morampudi Junction', 600, 610, 440, 980],
      ['Visakhapatnam', 'Dwaraka Nagar', 800, 800, 640, 1400],
    ]),
  });
  const hydBlr = await createRoute(staff.DS, {
    code: 'HYD-BLR', name: 'Hyderabad → Bengaluru (NH44)',
    stops: stops([
      ['Hyderabad', 'Kukatpally Housing Board', 0, 0, 0, 0],
      ['Hyderabad', 'Mehdipatnam', 40, 50, 15, 30],
      ['Kurnool', 'Kurnool Bypass', 260, 270, 215, 520],
      ['Anantapur', 'Anantapur Clock Tower', 420, 430, 360, 820],
      ['Bengaluru', 'Hebbal Flyover', 600, 610, 560, 1150],
      ['Bengaluru', 'Majestic (Kempegowda BS)', 640, 640, 572, 1200],
    ]),
  });
  const vjaHyd = await createRoute(staff.DS, {
    code: 'VJA-HYD', name: 'Vijayawada → Hyderabad',
    stops: stops([
      ['Vijayawada', 'Benz Circle', 0, 0, 0, 0],
      ['Suryapet', 'Suryapet Bus Stand', 160, 170, 125, 300],
      ['Hyderabad', 'LB Nagar Ring Road', 290, 300, 252, 560],
      ['Hyderabad', 'Ameerpet Metro', 340, 340, 272, 600],
    ]),
  });
  const delAsr = await createRoute(staff.PH, {
    code: 'DEL-ASR', name: 'Delhi → Amritsar (via LPU, Phagwara)',
    stops: stops([
      ['Delhi', 'Kashmere Gate ISBT', 0, 0, 0, 0],
      ['Ambala', 'Ambala Cantt Bus Stand', 210, 220, 200, 450],
      ['Ludhiana', 'Ludhiana Bus Stand', 330, 340, 310, 700],
      ['Phagwara', 'LPU Main Gate', 385, 390, 350, 800],
      ['Jalandhar', 'Jalandhar Bus Stand', 415, 425, 372, 850],
      ['Amritsar', 'Amritsar ISBT', 500, 500, 455, 1000],
    ]),
  });
  const cheTpt = await createRoute(staff.CC, {
    code: 'CHE-TPT', name: 'Chennai → Tirupati',
    stops: stops([
      ['Chennai', 'Koyambedu CMBT', 0, 0, 0, 0],
      ['Tiruvallur', 'Tiruvallur Bus Stand', 70, 75, 45, 120],
      ['Puttur', 'Puttur Gate', 150, 155, 105, 230],
      ['Tirupati', 'Tirupati Central Bus Stand', 220, 220, 140, 320],
    ]),
  });

  // ---------------------------------------------------------------- schedules + trips (today .. +21 days)
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  const from = istDate(0);
  const to = istDate(21);
  const sch = async (actor: Actor, routeId: string, busId: string, departureTime: string, fareMultiplier = 1, daysOfWeek = everyDay) => {
    const s = await createSchedule(actor, { routeId, busId, departureTime, daysOfWeek, fareMultiplier });
    await generateTrips(actor, s.id, { fromDate: from, toDate: to });
    return s.id;
  };
  await sch(staff.DS, hydVizag.id, buses.dsSleeper1, '19:30', 1.0);
  await sch(staff.DS, hydBlr.id, buses.dsVolvo, '21:00', 1.15);
  await sch(staff.DS, vjaHyd.id, buses.dsSleeper2, '22:30', 1.0);
  await sch(staff.PH, delAsr.id, buses.phSleeper, '22:00', 1.0);
  await sch(staff.PH, delAsr.id, buses.phSeater, '07:00', 0.8);
  await sch(staff.CC, cheTpt.id, buses.ccSeater, '06:00', 1.0);
  await sch(staff.CC, cheTpt.id, buses.ccSemi, '14:00', 1.2, [5, 6, 0]); // weekend service, premium fare

  // ---------------------------------------------------------------- passengers & sample bookings
  const passengers = [
    ['ravi@example.com', 'Ravi Teja', '9876500001'],
    ['priya@example.com', 'Priya Sharma', '9876500002'],
    ['arjun@example.com', 'Arjun Reddy', '9876500003'],
    ['meera@example.com', 'Meera Nair', '9876500004'],
    ['harpreet@example.com', 'Harpreet Kaur', '9876500005'],
  ];
  const pax: Actor[] = [];
  for (const [email, name, phone] of passengers) pax.push(asActor(await insertUser(email, name, 'PASSENGER', DEMO_PASSWORDS.passenger, null, phone)));

  const tripOn = async (routeId: string, dayOffset: number, time?: string) =>
    (await queryOne<{ id: string }>(
      `SELECT t.id FROM trips t JOIN schedules s ON s.id = t.schedule_id
        WHERE t.route_id = $1 AND t.service_date = $2 AND ($3::text IS NULL OR to_char(s.departure_time, 'HH24:MI') = $3)`,
      [routeId, istDate(dayOffset), time ?? null],
    ))?.id;

  const book = async (who: Actor, tripId: string | undefined, fromStop: number, toStop: number, seats: string[], names: [string, number, 'MALE' | 'FEMALE'][]) => {
    if (!tripId) return null;
    const hold = await createHold(who, tripId, { fromStop, toStop, seats });
    const res = await createBooking(who, randomUUID(), {
      holdToken: hold.holdToken,
      contactEmail: who.email,
      contactPhone: passengers.find((p) => p[0] === who.email)![2],
      passengers: seats.map((s, i) => ({ seatLabel: s, name: names[i][0], age: names[i][1], gender: names[i][2] })),
    });
    return res.body.data.pnr as string;
  };

  const v1 = await tripOn(hydVizag.id, 1);
  const v2 = await tripOn(hydVizag.id, 2);
  const d1 = await tripOn(delAsr.id, 1, '22:00');
  const c3 = await tripOn(cheTpt.id, 3, '06:00');

  const made: string[] = [];
  const push = (p: string | null) => p && made.push(p);
  // Segment reuse showcase on tomorrow's HYD→VSKP: L1 sold Ameerpet→Vijayawada AND Vijayawada→Vizag.
  push(await book(pax[0], v1, 1, 4, ['L1', 'L2'], [['Ravi Teja', 27, 'MALE'], ['Lakshmi Teja', 52, 'FEMALE']]));
  push(await book(pax[1], v1, 4, 6, ['L1'], [['Priya Sharma', 24, 'FEMALE']]));
  push(await book(pax[2], v1, 0, 6, ['U3', 'U4', 'U5'], [['Arjun Reddy', 31, 'MALE'], ['Sita Reddy', 29, 'FEMALE'], ['Kiran Reddy', 8, 'MALE']]));
  push(await book(pax[3], v1, 2, 5, ['L7'], [['Meera Nair', 35, 'FEMALE']]));
  push(await book(pax[0], v2, 0, 6, ['L4', 'L5'], [['Ravi Teja', 27, 'MALE'], ['Sai Kumar', 26, 'MALE']]));
  push(await book(pax[4], d1, 0, 3, ['L2'], [['Harpreet Kaur', 21, 'FEMALE']]));
  push(await book(pax[4], d1, 3, 5, ['L2', 'L3'], [['Gurpreet Singh', 22, 'MALE'], ['Simran Kaur', 20, 'FEMALE']]));
  push(await book(pax[1], d1, 0, 5, ['U1'], [['Priya Sharma', 24, 'FEMALE']]));
  push(await book(pax[3], c3, 0, 3, ['1', '2', '3', '4'], [['Meera Nair', 35, 'FEMALE'], ['Anil Nair', 38, 'MALE'], ['Diya Nair', 10, 'FEMALE'], ['Dev Nair', 6, 'MALE']]));
  push(await book(pax[2], c3, 1, 3, ['12'], [['Arjun Reddy', 31, 'MALE']]));

  // Cancellations: one full, one partial; then process one refund through the simulated gateway.
  if (made[4]) await cancelBooking(pax[0], made[4], { reason: 'Change of plans' });
  if (made[8]) {
    const b = await queryOne(`SELECT id FROM bookings WHERE pnr = $1`, [made[8]]);
    const t = await queryOne(`SELECT id FROM tickets WHERE booking_id = $1 AND seat_label = '4'`, [b.id]);
    await cancelBooking(pax[3], made[8], { ticketIds: [t.id], reason: 'Child not travelling' });
  }
  const pending = await queryOne(`SELECT id FROM refunds WHERE status = 'PENDING' ORDER BY created_at LIMIT 1`);
  if (pending) await transitionRefund(admin, pending.id, { status: 'PROCESSED' });

  log(`Seed complete: ${CITIES.length} cities, 3 operators, 7 buses, 5 routes, ${made.length} bookings.`);
  log('Demo logins:');
  log(`  admin      admin@safar.dev            ${DEMO_PASSWORDS.admin}`);
  log(`  operator   ops.deccan@safar.dev       ${DEMO_PASSWORDS.operator}   (also ops.punjab@ / ops.coromandel@)`);
  log(`  passenger  ravi@example.com           ${DEMO_PASSWORDS.passenger}  (also priya@ / arjun@ / meera@ / harpreet@)`);
}
