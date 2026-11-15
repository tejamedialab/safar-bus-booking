import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, queryOne } from '../src/db/pool.js';
import { DEMO_PASSWORDS } from '../src/db/seed.js';

export const app = createApp();
export const http = () => request(app);
export const API = '/api/v1';

export async function login(email: string, password: string): Promise<string> {
  const res = await http().post(`${API}/auth/login`).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

export const asAdmin = () => login('admin@safar.dev', DEMO_PASSWORDS.admin);
export const asDeccanOps = () => login('ops.deccan@safar.dev', DEMO_PASSWORDS.operator);
export const asPunjabOps = () => login('ops.punjab@safar.dev', DEMO_PASSWORDS.operator);
export const asRavi = () => login('ravi@example.com', DEMO_PASSWORDS.passenger);
export const asPriya = () => login('priya@example.com', DEMO_PASSWORDS.passenger);

let n = 0;
/** Registers a brand-new passenger and returns their token. */
export async function newPassenger(): Promise<{ token: string; email: string }> {
  n += 1;
  const email = `test.${Date.now()}.${n}.${Math.floor(Math.random() * 1e6)}@example.com`;
  const res = await http()
    .post(`${API}/auth/register`)
    .send({ fullName: `Test Passenger ${n}`, email, phone: '9123456789', password: 'Passw0rd!x' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.data.token, email };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Clones a seeded route (same stops, offsets and fares) onto private "Fixture" cities, once per
 * test file, so fixture trips never show up in the public search results other tests assert on.
 */
const fixtureRoutes = new Map<string, { id: string; operator_id: string }>();
async function fixtureRoute(code: string) {
  if (fixtureRoutes.has(code)) return fixtureRoutes.get(code)!;
  const src = await queryOne(`SELECT id, operator_id FROM routes WHERE code = $1`, [code]);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const route = await queryOne(
    `INSERT INTO routes (operator_id, code, name) VALUES ($1, $2, $3) RETURNING id, operator_id`,
    [src.operator_id, `T-${suffix}`, `Fixture copy of ${code}`],
  );
  const stops = await query(`SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_order`, [src.id]);
  for (const st of stops) {
    const city = await queryOne(
      `INSERT INTO cities (name, state) VALUES ($1, 'Test') ON CONFLICT ((lower(name))) DO UPDATE SET state = 'Test' RETURNING id`,
      [`Fixture-${suffix}-${st.stop_order}`],
    );
    await query(
      `INSERT INTO route_stops (route_id, stop_order, city_id, point_name, arrival_offset_min, departure_offset_min, distance_km, cumulative_fare_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [route.id, st.stop_order, city.id, st.point_name, st.arrival_offset_min, st.departure_offset_min, st.distance_km, st.cumulative_fare_paise],
    );
  }
  fixtureRoutes.set(code, route);
  return route;
}

/**
 * Test fixture: a SCHEDULED trip on a private copy of the seeded HYD→VSKP route that departs `hoursFromNow` hours
 * from now (on its own bus so it never collides with seeded trips). Using SQL here is deliberate:
 * real schedules only run at fixed clock times, but policy tests need precise lead times.
 */
export async function makeTrip(hoursFromNow: number, routeCode = 'HYD-VSKP'): Promise<string> {
  const route = await fixtureRoute(routeCode);
  const layout = await queryOne(`SELECT id FROM seat_layouts WHERE name LIKE 'Sleeper%'`);
  const reg = `TS${String(10 + Math.floor(Math.random() * 89))}ZZ${String(Math.floor(1000 + Math.random() * 8999))}`;
  const bus = await queryOne(
    `INSERT INTO buses (operator_id, registration_no, bus_type, seat_layout_id) VALUES ($1, $2, 'AC_SLEEPER', $3) RETURNING id`,
    [route.operator_id, reg, layout.id],
  );
  const sc = await queryOne(
    `INSERT INTO schedules (route_id, bus_id, departure_time, days_of_week) VALUES ($1, $2, '00:00', '{0,1,2,3,4,5,6}') RETURNING id`,
    [route.id, bus.id],
  );
  const trip = await queryOne(
    `INSERT INTO trips (schedule_id, route_id, bus_id, seat_layout_id, service_date, departs_at, arrives_at, fare_multiplier)
     VALUES ($1, $2, $3, $4, (now() + make_interval(hours => $5) + make_interval(mins => $6))::date,
             now() + make_interval(hours => $5) + make_interval(mins => $6),
             now() + make_interval(hours => $5) + make_interval(mins => $6) + interval '14 hours', 1.0)
     RETURNING id`,
    [sc.id, route.id, bus.id, layout.id, Math.floor(hoursFromNow), Math.round((hoursFromNow % 1) * 60)],
  );
  return trip.id;
}

export interface PassengerSpec {
  seatLabel: string;
  name?: string;
  age?: number;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
}

const NAMES = ['Anand', 'Bhavana', 'Chitra', 'Dinesh', 'Esha', 'Farhan', 'Gauri', 'Harsha'];

/** Full happy path: hold seats then confirm. Returns the booking response body. */
export async function holdAndBook(token: string, tripId: string, fromStop: number, toStop: number, seats: string[]) {
  const hold = await http()
    .post(`${API}/trips/${tripId}/holds`)
    .set(bearer(token))
    .send({ fromStop, toStop, seats });
  if (hold.status !== 201) return { hold, booking: null as any };
  const booking = await http()
    .post(`${API}/bookings`)
    .set(bearer(token))
    .set('Idempotency-Key', randomUUID())
    .send({
      holdToken: hold.body.data.holdToken,
      contactEmail: 'traveller@example.com',
      contactPhone: '9876543210',
      passengers: seats.map((s, i) => ({ seatLabel: s, name: `Traveller ${NAMES[i % NAMES.length]}`, age: 30 + i, gender: i % 2 ? 'FEMALE' : 'MALE' })),
    });
  return { hold, booking };
}

export async function confirmedTicketsFor(tripId: string, seat: string) {
  return query(`SELECT * FROM tickets WHERE trip_id = $1 AND seat_label = $2 AND status = 'CONFIRMED'`, [tripId, seat]);
}

export { randomUUID };
