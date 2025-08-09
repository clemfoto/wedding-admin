import React, { useEffect, useMemo, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Elegance Photographie — Admin App (React + Supabase)
 * ---------------------------------------------------
 * - Autenticación por Magic Link (email) y sesión persistente
 * - CRUD en tiempo real (RLS seguro) para: clients, events, special_requests, payments, tasks, deliverables, vendors
 * - Resumen contable mensual, recordatorios cercanos, búsquedas y acciones rápidas
 * - Importar / Exportar JSON (backups manuales)
 *
 * Cómo usar (rápido):
 * 1) Crea un proyecto en https://supabase.com
 * 2) En Supabase > SQL Editor, pega el SQL del esquema (abajo en SCHEMA_SQL) y ejecútalo
 * 3) Copia tus credenciales y reemplaza SUPABASE_URL y SUPABASE_ANON_KEY
 * 4) Arranca esta app (Vite/CRA) y entra con tu correo (Magic Link)
 * 5) ¡Listo! Ya estás operando con datos en la nube + tiempo real
 */

// =========================
// CONFIG — ENV (rellena con tus valores de Supabase)
// =========================
const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || "https://YOUR_PROJECT_ID.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || "YOUR_PUBLIC_ANON_KEY";

// =========================
// SQL de esquema — pégalo en Supabase SQL Editor (una sola vez)
// =========================
export const SCHEMA_SQL = `
-- Habilitar extensiones útiles
create extension if not exists pgcrypto;
create extension if not exists moddatetime;

-- Tabla de usuarios (perfiles simples)
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  email text unique,
  full_name text,
  created_at timestamp with time zone default now()
);

-- Colecciones
create table if not exists clients (
  client_id text primary key,
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  country text,
  timezone text,
  preferred_language text,
  whatsapp text,
  instagram text,
  lead_source text,
  notes text,
  owner uuid references auth.users default auth.uid(),
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists events (
  event_id text primary key,
  client_id text references clients(client_id) on delete cascade,
  partner_name text,
  event_date date not null,
  location_city text,
  venue_name text,
  hotel_external_vendor_fee_usd numeric,
  package_name text,
  hours_coverage int,
  photographers int,
  videographers int,
  status text check (status in ('lead','signed','delivered')),
  contract_url text,
  deposit_due_date date,
  deposit_amount_usd numeric,
  balance_due_date date,
  balance_amount_usd numeric,
  owner uuid references auth.users default auth.uid(),
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists special_requests (
  request_id text primary key,
  event_id text references events(event_id) on delete cascade,
  category text check (category in ('photo','video','other')),
  description text not null,
  priority text check (priority in ('low','medium','high')),
  owner_name text,
  due_date date,
  status text check (status in ('open','done')) default 'open',
  created_at timestamptz default now(),
  owner uuid references auth.users default auth.uid()
);

create table if not exists payments (
  payment_id text primary key,
  event_id text references events(event_id) on delete cascade,
  type text check (type in ('deposit','balance','other')),
  currency text check (currency in ('USD','MXN')),
  amount numeric not null,
  due_date date not null,
  paid_date date,
  method text,
  invoice_number text,
  receipt_url text,
  status text check (status in ('pending','paid','overdue')) default 'pending',
  owner uuid references auth.users default auth.uid(),
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists tasks (
  task_id text primary key,
  event_id text references events(event_id) on delete set null,
  title text not null,
  description text,
  assignee text,
  due_date date,
  status text check (status in ('todo','doing','done')) default 'todo',
  owner uuid references auth.users default auth.uid(),
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists deliverables (
  deliverable_id text primary key,
  event_id text references events(event_id) on delete cascade,
  type text check (type in ('sneak_peek','slideshow','coming_soon','highlight','album','photos','other')),
  due_date date,
  delivered_date date,
  link text,
  revision_deadline date,
  owner uuid references auth.users default auth.uid(),
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists vendors (
  vendor_id text primary key,
  event_id text references events(event_id) on delete cascade,
  type text check (type in ('planner','dj','makeup','venue','photo','video','other')),
  name text not null,
  contact text,
  notes text,
  owner uuid references auth.users default auth.uid(),
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Triggers updated_at
create or replace function set_updated_at() returns trigger as $$ begin new.updated_at = now(); return new; end; $$ language plpgsql;
create trigger clients_updated before update on clients for each row execute function set_updated_at();
create trigger events_updated before update on events for each row execute function set_updated_at();
create trigger payments_updated before update on payments for each row execute function set_updated_at();
create trigger tasks_updated before update on tasks for each row execute function set_updated_at();
create trigger deliverables_updated before update on deliverables for each row execute function set_updated_at();
create trigger vendors_updated before update on vendors for each row execute function set_updated_at();

-- RLS
alter table clients enable row level security;
alter table events enable row level security;
alter table special_requests enable row level security;
alter table payments enable row level security;
alter table tasks enable row level security;
alter table deliverables enable row level security;
alter table vendors enable row level security;

create policy tenant_isolation_clients on clients for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy tenant_isolation_events on events for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy tenant_isolation_requests on special_requests for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy tenant_isolation_payments on payments for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy tenant_isolation_tasks on tasks for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy tenant_isolation_deliverables on deliverables for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy tenant_isolation_vendors on vendors for all using (owner = auth.uid()) with check (owner = auth.uid());
`;

// =========================
// Tipos/base de datos
// =========================
export type Client = { client_id: string; first_name: string; last_name: string; email?: string; phone?: string; country?: string; timezone?: string; preferred_language?: string; whatsapp?: string; instagram?: string; lead_source?: string; notes?: string; };
export type Event = { event_id: string; client_id: string; partner_name?: string; event_date: string; location_city?: string; venue_name?: string; hotel_external_vendor_fee_usd?: number; package_name?: string; hours_coverage?: number; photographers?: number; videographers?: number; status?: "lead" | "signed" | "delivered"; contract_url?: string; deposit_due_date?: string; deposit_amount_usd?: number; balance_due_date?: string; balance_amount_usd?: number; };
export type SpecialRequest = { request_id: string; event_id: string; category: "photo" | "video" | "other"; description: string; priority: "low" | "medium" | "high"; owner_name?: string; due_date?: string; status: "open" | "done"; created_at: string; };
export type Payment = { payment_id: string; event_id: string; type: "deposit" | "balance" | "other"; currency: "USD" | "MXN"; amount: number; due_date: string; paid_date?: string; method?: string; invoice_number?: string; receipt_url?: string; status: "pending" | "paid" | "overdue"; };
export type Task = { task_id: string; event_id?: string; title: string; description?: string; assignee?: string; due_date?: string; status: "todo" | "doing" | "done"; };
export type Deliverable = { deliverable_id: string; event_id: string; type: "sneak_peek" | "slideshow" | "coming_soon" | "highlight" | "album" | "photos" | "other"; due_date?: string; delivered_date?: string; link?: string; revision_deadline?: string; };
export type Vendor = { vendor_id: string; event_id: string; type: "planner" | "dj" | "makeup" | "venue" | "photo" | "video" | "other"; name: string; contact?: string; notes?: string; };
export type AppState = { clients: Client[]; events: Event[]; special_requests: SpecialRequest[]; payments: Payment[]; tasks: Task[]; deliverables: Deliverable[]; vendors: Vendor[]; };

const currency = (n: number, c = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n || 0);
const fmtDate = (s?: string) => (s ? new Date(s).toLocaleDateString() : "");
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(new Date(iso).getTime() + d * 86400000).toISOString().slice(0, 10);
const withinDays = (iso: string, days: number) => { const now = new Date(); const tgt = new Date(iso); const diff = (tgt.getTime() - now.getTime()) / 86400000; return diff >= 0 && diff <= days; };
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

// =========================
// Supabase Client + Data Layer
// =========================
let supabase: SupabaseClient | null = null;
try { supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch {}

async function sbList<T>(table: string) { if (!supabase) return [] as T[]; const { data, error } = await supabase.from(table).select("*").order("inserted_at", { ascending: false }); if (error) throw error; return data as T[]; }
async function sbInsert<T>(table: string, payload: any) { if (!supabase) return payload as T; const { data, error } = await supabase.from(table).insert(payload).select().single(); if (error) throw error; return data as T; }
async function sbUpdate<T>(table: string, idKey: string, payload: any) { if (!supabase) return payload as T; const { data, error } = await supabase.from(table).update(payload).eq(idKey, payload[idKey]).select().single(); if (error) throw error; return data as T; }
async function sbDelete(table: string, idKey: string, id: string) { if (!supabase) return true; const { error } = await supabase.from(table).delete().eq(idKey, id); if (error) throw error; return true; }

// =========================
// Auth Hook (Magic Link)
// =========================
function useSupabaseAuth() {
  const [session, setSession] = useState<any>(null);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => { sub?.subscription.unsubscribe(); };
  }, []);
  const signIn = async (email: string) => {
  if (!supabase) {                 // ✅ evita el error "posiblemente null"
    alert("Configura VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY");
    return;
  }

  const redirectTo =
    import.meta.env.PROD
      ? "https://wedding-admin-gamma.vercel.app"   // ✅ tu dominio en Vercel
      : window.location.origin;                    // dev (localhost/IP)

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo }
  });

  if (error) alert("No se pudo enviar el Magic Link: " + error.message);
  else alert("Revisa tu correo para continuar el login.");
};

  const signOut = async () => { await supabase?.auth.signOut(); };
  return { session, signIn, signOut };
}

// =========================
// Store principal (carga inicial desde Supabase)
// =========================
function useStore(initial: AppState) {
  const [state, setState] = useState<AppState>(initial);
  const [loading, setLoading] = useState<boolean>(!!supabase);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!supabase) return; // sigue con demo local si no hay credenciales
      try {
        setLoading(true);
        const [clients, events, special_requests, payments, tasks, deliverables, vendors] = await Promise.all([
          sbList<Client>("clients"), sbList<Event>("events"), sbList<SpecialRequest>("special_requests"), sbList<Payment>("payments"), sbList<Task>("tasks"), sbList<Deliverable>("deliverables"), sbList<Vendor>("vendors")
        ]);
        setState({ clients, events, special_requests, payments, tasks, deliverables, vendors });
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Suscripciones en tiempo real
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase.channel("db-changes")
      .on("postgres_changes", { event: "*", schema: "public" }, (_payload) => {
        // Simplificación: refetch ligero. En producción, aplicar diffs por tabla.
        Promise.all([
          sbList<Client>("clients"), sbList<Event>("events"), sbList<SpecialRequest>("special_requests"), sbList<Payment>("payments"), sbList<Task>("tasks"), sbList<Deliverable>("deliverables"), sbList<Vendor>("vendors")
        ]).then(([clients, events, special_requests, payments, tasks, deliverables, vendors]) => {
          setState({ clients, events, special_requests, payments, tasks, deliverables, vendors });
        });
      })
      .subscribe();
    return () => { supabase?.removeChannel(channel); };
  }, []);

  return { state, setState, loading, error } as const;
}

// =========================
// DEMO local (fallback si no hay Supabase)
// =========================
const demo: AppState = {
  clients: [{ client_id: "C-0001", first_name: "Alex", last_name: "Johnson", email: "alex@email.com", phone: "+1 555 555 5555", country: "USA", timezone: "America/Chicago", preferred_language: "en", whatsapp: "yes", instagram: "@alexandmaria", lead_source: "WeddingWire", notes: "Prefiere comunicación por WhatsApp." }],
  events: [{ event_id: "E-0001", client_id: "C-0001", partner_name: "Maria Lopez", event_date: "2025-12-12", location_city: "Playa del Carmen", venue_name: "Hotel X", hotel_external_vendor_fee_usd: 250, package_name: "Elegance Photo + Video", hours_coverage: 8, photographers: 1, videographers: 1, status: "signed", contract_url: "https://example.com/contract/123", deposit_due_date: addDays(todayISO(), 11), deposit_amount_usd: 1200, balance_due_date: "2025-12-12", balance_amount_usd: 1800 }],
  special_requests: [{ request_id: "R-0001", event_id: "E-0001", category: "photo", description: "Fotos con abuela antes de la ceremonia; foto de anillos sobre conchas.", priority: "high", owner_name: "Clem", due_date: "2025-12-12", status: "open", created_at: todayISO() }],
  payments: [{ payment_id: "P-0001", event_id: "E-0001", type: "deposit", currency: "USD", amount: 1200, due_date: addDays(todayISO(), 11), method: "wire", invoice_number: "INV-2025-001", receipt_url: "", status: "pending" }],
  tasks: [{ task_id: "T-0001", event_id: "E-0001", title: "Revisar timeline con planner", description: "Confirmar horarios de getting ready, first look y ceremonia.", assignee: "Clem", due_date: addDays(todayISO(), 5), status: "todo" }],
  deliverables: [{ deliverable_id: "D-0001", event_id: "E-0001", type: "sneak_peek", due_date: addDays("2025-12-12", 7), link: "", revision_deadline: addDays("2025-12-12", 60) }],
  vendors: [{ vendor_id: "V-0001", event_id: "E-0001", type: "planner", name: "Ana Planner", contact: "+52 1 999 000 0000", notes: "Muy puntual, coordina con DJ." }],
};

// =========================
// UI helpers
// =========================
function SectionHeader({ title, children }: React.PropsWithChildren<{ title: string }>) { return (<div className="flex items-center justify-between mb-3"><h2 className="text-xl font-semibold">{title}</h2><div className="flex gap-2">{children}</div></div>); }
function Card({ children }: React.PropsWithChildren<{}>) { return <div className="rounded-2xl shadow p-4 bg-white">{children}</div>; }
function Pill({ children, className = "" }: React.PropsWithChildren<{ className?: string }>) { return (<span className={`px-2 py-1 rounded-full text-xs border ${className}`}>{children}</span>); }
function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`border rounded-xl px-3 py-2 w-full ${className}`} />; }
function TextArea({ className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={`border rounded-xl px-3 py-2 w-full min-h-[80px] ${className}`} />; }
function Select({ className = "", ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={`border rounded-xl px-3 py-2 w-full ${className}`} />; }
function Button({ className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return (<button {...props} className={`px-4 py-2 rounded-2xl shadow text-sm bg-black text-white hover:opacity-80 active:opacity-90 ${className}`} />); }

// =========================
// Módulos (conectados a Supabase cuando hay credenciales)
// =========================
function Dashboard({ state }: { state: AppState }) {
  const upcomingPayments = useMemo(() => state.payments.filter((p) => p.status !== "paid" && withinDays(p.due_date, 14)).slice(0, 5), [state.payments]);
  const openRequests = useMemo(() => state.special_requests.filter((r) => r.status === "open").slice(0, 6), [state.special_requests]);
  const nextEvents = useMemo(() => [...state.events].filter(e => new Date(e.event_date) >= new Date()).sort((a,b)=> a.event_date.localeCompare(b.event_date)).slice(0,4), [state.events]);
  const totalUSD = state.payments.filter(p=>p.currency==='USD').reduce((s,p)=> s + (Number(p.amount)||0), 0);
  const totalMXN = state.payments.filter(p=>p.currency==='MXN').reduce((s,p)=> s + (Number(p.amount)||0), 0);
  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Próximos pagos (≤14 días)" />
        <div className="space-y-2">
          {upcomingPayments.length === 0 && <div className="text-sm text-gray-500">Sin pagos próximos.</div>}
          {upcomingPayments.map((p) => (
            <div key={p.payment_id} className="flex items-center justify-between border rounded-xl px-3 py-2">
              <div>
                <div className="font-medium">{p.type.toUpperCase()} · {currency(Number(p.amount), p.currency)}</div>
                <div className="text-xs text-gray-500">Vence: {fmtDate(p.due_date)}</div>
              </div>
              <Pill className="border-gray-300">{p.status}</Pill>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <SectionHeader title="Solicitudes especiales abiertas" />
        <div className="space-y-2">
          {openRequests.length === 0 && <div className="text-sm text-gray-500">Sin solicitudes abiertas.</div>}
          {openRequests.map((r) => (
            <div key={r.request_id} className="border rounded-xl px-3 py-2">
              <div className="font-medium line-clamp-1">{r.description}</div>
              <div className="text-xs text-gray-500">Prioridad: {r.priority} · Entrega: {fmtDate(r.due_date)}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <SectionHeader title="Resumen rápido" />
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="border rounded-xl p-3"><div className="text-gray-500">Clientes</div><div className="text-2xl font-semibold">{state.clients.length}</div></div>
          <div className="border rounded-xl p-3"><div className="text-gray-500">Eventos</div><div className="text-2xl font-semibold">{state.events.length}</div></div>
          <div className="border rounded-xl p-3"><div className="text-gray-500">Pagos (USD)</div><div className="text-2xl font-semibold">{currency(totalUSD, 'USD')}</div></div>
          <div className="border rounded-xl p-3"><div className="text-gray-500">Pagos (MXN)</div><div className="text-2xl font-semibold">{currency(totalMXN || 0, 'MXN')}</div></div>
        </div>
        <div className="mt-3">
          <div className="text-gray-500 text-sm mb-1">Próximos eventos</div>
          <ul className="text-sm space-y-1">
            {nextEvents.map(ev => (
              <li key={ev.event_id} className="flex items-center justify-between border rounded-xl px-3 py-2">
                <span>{fmtDate(ev.event_date)} · {ev.venue_name}</span>
                <Pill className="border-gray-300">{ev.status}</Pill>
              </li>
            ))}
            {nextEvents.length===0 && <li className="text-gray-500">No hay próximos eventos.</li>}
          </ul>
        </div>
      </Card>
    </div>
  );
}

function Toolbar({ onImport, onExport, onReset }: { onImport: (file: File) => void; onExport: () => void; onReset: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <label className="px-4 py-2 rounded-2xl border cursor-pointer">Importar JSON
        <input type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); }} />
      </label>
      <Button onClick={onExport}>Exportar JSON</Button>
      <button className="px-4 py-2 rounded-2xl border" onClick={onReset}>Reset demo</button>
    </div>
  );
}

function ClientsModule({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => state.clients.filter(c => [c.first_name, c.last_name, c.instagram, c.email, c.phone].join(" ").toLowerCase().includes(q.toLowerCase())), [state.clients, q]);
  const [form, setForm] = useState<Client>({ client_id: "", first_name: "", last_name: "" });

  const add = async () => {
    if (!form.first_name || !form.last_name) return;
    const newItem = { ...form, client_id: form.client_id || uid("C") } as Client;
    setState({ ...state, clients: [newItem, ...state.clients] });
    try { await sbInsert<Client>("clients", newItem); } catch (e:any) { alert(e.message); }
    setForm({ client_id: "", first_name: "", last_name: "" });
  };
  const remove = async (id: string) => {
    if (!confirm("¿Eliminar cliente?")) return;
    setState({ ...state, clients: state.clients.filter(x => x.client_id !== id) });
    try { await sbDelete("clients", "client_id", id); } catch (e:any) { alert(e.message); }
  }

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Nuevo cliente" />
        <div className="space-y-2">
          <Input placeholder="Nombre" value={form.first_name} onChange={e=>setForm({...form, first_name: e.target.value})} />
          <Input placeholder="Apellidos" value={form.last_name} onChange={e=>setForm({...form, last_name: e.target.value})} />
          <Input placeholder="Email" value={form.email||""} onChange={e=>setForm({...form, email: e.target.value})} />
          <Input placeholder="Teléfono" value={form.phone||""} onChange={e=>setForm({...form, phone: e.target.value})} />
          <Input placeholder="Instagram" value={form.instagram||""} onChange={e=>setForm({...form, instagram: e.target.value})} />
          <Button onClick={add}>Agregar</Button>
        </div>
      </Card>

      <div className="md:col-span-2">
        <SectionHeader title="Clientes">
          <Input placeholder="Buscar…" value={q} onChange={e=>setQ(e.target.value)} className="w-56" />
        </SectionHeader>
        <div className="grid gap-3">
          {filtered.map(c => (
            <Card key={c.client_id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{c.first_name} {c.last_name}</div>
                  <div className="text-sm text-gray-600">{c.email} · {c.phone}</div>
                  <div className="text-xs text-gray-500">{c.instagram} · {c.country}</div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => navigator.clipboard.writeText(`${c.first_name} ${c.last_name} | ${c.phone||""}`)}>Copiar</Button>
                  <button className="px-3 py-2 rounded-2xl border" onClick={() => remove(c.client_id)}>Eliminar</button>
                </div>
              </div>
            </Card>
          ))}
          {filtered.length===0 && <div className="text-gray-500">Sin resultados.</div>}
        </div>
      </div>
    </div>
  );
}

function PaymentsModule({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Payment>({ payment_id: "", event_id: state.events[0]?.event_id || "", type: "deposit", currency: "USD", amount: 0, due_date: todayISO(), status: "pending" });
  const list = useMemo(() => state.payments.filter(p => [p.type, p.currency, p.status, p.invoice_number].join(" ").toLowerCase().includes(q.toLowerCase())).sort((a,b)=> a.due_date.localeCompare(b.due_date)), [state.payments, q]);

  const add = async () => {
    if (!form.event_id) return alert("Selecciona un evento");
    const item = { ...form, payment_id: form.payment_id || uid("P") } as Payment;
    setState({ ...state, payments: [item, ...state.payments] });
    try { await sbInsert<Payment>("payments", item); } catch (e:any) { alert(e.message); }
  };
  const markPaid = async (id: string) => {
  // ✅ Forzamos que el resultado del map sea Payment[]
  const updated = state.payments.map<Payment>(p =>
    p.payment_id === id
      ? { ...p, status: "paid" as const, paid_date: todayISO() } // ✅ literal "paid"
      : p
  );

  setState({ ...state, payments: updated });

  try {
    const target = updated.find(p => p.payment_id === id)!; // ya es Payment
    await sbUpdate<Payment>("payments", "payment_id", target);
  } catch (e: any) {
    alert(e.message);
  }
};

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar pago?")) return;
    setState({ ...state, payments: state.payments.filter(x => x.payment_id !== id) });
    try { await sbDelete("payments", "payment_id", id); } catch (e:any) { alert(e.message); }
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Nuevo pago" />
        <div className="space-y-2">
          <Select value={form.event_id} onChange={e=>setForm({...form, event_id: e.target.value})}>
            <option value="">— Evento —</option>
            {state.events.map(ev => <option key={ev.event_id} value={ev.event_id}>{fmtDate(ev.event_date)} · {ev.venue_name}</option>)}
          </Select>
          <Select value={form.type} onChange={e=>setForm({...form, type: e.target.value as Payment["type"]})}>
            <option value="deposit">Depósito</option>
            <option value="balance">Saldo</option>
            <option value="other">Otro</option>
          </Select>
          <Select value={form.currency} onChange={e=>setForm({...form, currency: e.target.value as Payment["currency"]})}>
            <option value="USD">USD</option>
            <option value="MXN">MXN</option>
          </Select>
          <Input type="number" placeholder="Monto" value={form.amount} onChange={e=>setForm({...form, amount: Number(e.target.value)})} />
          <Input type="date" value={form.due_date} onChange={e=>setForm({...form, due_date: e.target.value})} />
          <Button onClick={add}>Agregar</Button>
        </div>
      </Card>

      <div className="md:col-span-2">
        <SectionHeader title="Pagos">
          <Input placeholder="Buscar…" value={q} onChange={e=>setQ(e.target.value)} className="w-56" />
        </SectionHeader>
        <div className="grid gap-3">
          {list.map(p => (
            <Card key={p.payment_id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{p.type.toUpperCase()} · {currency(Number(p.amount), p.currency)}</div>
                  <div className="text-xs text-gray-500">Vence: {fmtDate(p.due_date)} · Estado: {p.status}</div>
                </div>
                <div className="flex gap-2">
                  {p.status!=="paid" && <Button onClick={()=>markPaid(p.payment_id)}>Marcar pagado</Button>}
                  <button className="px-3 py-2 rounded-2xl border" onClick={()=>remove(p.payment_id)}>Eliminar</button>
                </div>
              </div>
            </Card>
          ))}
          {list.length===0 && <div className="text-gray-500">Sin pagos.</div>}
        </div>
      </div>
    </div>
  );
}

function AccountingModule({ state }: { state: AppState }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0,7));
  const [currencySel, setCurrencySel] = useState<"USD"|"MXN">("USD");
  const summary = useMemo(() => {
    const [y,m] = month.split("-").map(Number);
    const first = new Date(y, m-1, 1); const last = new Date(y, m, 0);
    const inRange = (d?: string) => d ? (new Date(d) >= first && new Date(d) <= last) : false;
    const due = state.payments.filter(p => p.currency===currencySel && inRange(p.due_date)).reduce((s,p)=> s+Number(p.amount), 0);
    const paid = state.payments.filter(p => p.currency===currencySel && inRange(p.paid_date)).reduce((s,p)=> s+Number(p.amount), 0);
    const pending = due - paid; return { due, paid, pending };
  }, [state.payments, month, currencySel]);

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Filtro" />
        <div className="space-y-2">
          <Input type="month" value={month} onChange={e=>setMonth(e.target.value)} />
          <Select value={currencySel} onChange={e=>setCurrencySel(e.target.value as any)}>
            <option value="USD">USD</option>
            <option value="MXN">MXN</option>
          </Select>
        </div>
      </Card>
      <Card>
        <SectionHeader title="Resumen mensual" />
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between border rounded-xl px-3 py-2"><span>Vencimientos del mes</span><strong>{currency(summary.due, currencySel)}</strong></div>
          <div className="flex items-center justify-between border rounded-xl px-3 py-2"><span>Pagado en el mes</span><strong>{currency(summary.paid, currencySel)}</strong></div>
          <div className="flex items-center justify-between border rounded-xl px-3 py-2"><span>Pendiente</span><strong>{currency(summary.pending, currencySel)}</strong></div>
        </div>
      </Card>
      <Card>
        <SectionHeader title="Tips" />
        <ul className="list-disc pl-5 text-sm text-gray-600 space-y-1">
          <li>Marca pagos como “Pagado” el mismo día para ver el flujo real.</li>
          <li>Usa “Otros” para anticipos especiales o upsells (impresiones, reels extras).</li>
          <li>Exporta JSON cada mes como respaldo.</li>
        </ul>
      </Card>
    </div>
  );
}

function EventsModule({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Event>({ event_id: "", client_id: state.clients[0]?.client_id || "", event_date: todayISO(), status: "lead" } as Event);
  const list = useMemo(() => state.events.filter(e => [e.venue_name, e.location_city, e.package_name, e.status, e.event_date].join(" ").toLowerCase().includes(q.toLowerCase())).sort((a,b)=> a.event_date.localeCompare(b.event_date)), [state.events, q]);

  const add = async () => {
    if (!form.client_id || !form.event_date) return alert("Cliente y fecha son obligatorios");
    const item = { ...form, event_id: form.event_id || uid("E") } as Event;
    setState({ ...state, events: [item, ...state.events] });
    try { await sbInsert<Event>("events", item); } catch (e:any) { alert(e.message); }
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Nuevo evento" />
        <div className="space-y-2">
          <Select value={form.client_id} onChange={e=>setForm({...form, client_id: e.target.value})}>
            <option value="">— Cliente —</option>
            {state.clients.map(c => <option key={c.client_id} value={c.client_id}>{c.first_name} {c.last_name}</option>)}
          </Select>
          <Input type="date" value={form.event_date} onChange={e=>setForm({...form, event_date: e.target.value})} />
          <Input placeholder="Ciudad" value={form.location_city||""} onChange={e=>setForm({...form, location_city: e.target.value})} />
          <Input placeholder="Venue" value={form.venue_name||""} onChange={e=>setForm({...form, venue_name: e.target.value})} />
          <Input placeholder="Paquete" value={form.package_name||""} onChange={e=>setForm({...form, package_name: e.target.value})} />
          <Select value={form.status} onChange={e=>setForm({...form, status: e.target.value as any})}>
            <option value="lead">Lead</option>
            <option value="signed">Firmado</option>
            <option value="delivered">Entregado</option>
          </Select>
          <Button onClick={add}>Agregar</Button>
        </div>
      </Card>

      <div className="md:col-span-2">
        <SectionHeader title="Eventos">
          <Input placeholder="Buscar…" value={q} onChange={e=>setQ(e.target.value)} className="w-56" />
        </SectionHeader>
        <div className="grid gap-3">
          {list.map(ev => (
            <Card key={ev.event_id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{fmtDate(ev.event_date)} · {ev.venue_name || "(venue)"}</div>
                  <div className="text-xs text-gray-500">{ev.location_city} · {ev.package_name}</div>
                </div>
                <Pill className="border-gray-300">{ev.status}</Pill>
              </div>
            </Card>
          ))}
          {list.length===0 && <div className="text-gray-500">Sin eventos.</div>}
        </div>
      </div>
    </div>
  );
}

function RequestsModule({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [q, setQ] = useState("");
  const [form, setForm] = useState<SpecialRequest>({ request_id: "", event_id: state.events[0]?.event_id || "", category: "photo", description: "", priority: "medium", status: "open", created_at: new Date().toISOString(), });
  const list = useMemo(() => state.special_requests.filter(r => [r.description, r.priority, r.category, r.status].join(" ").toLowerCase().includes(q.toLowerCase())).sort((a,b)=> (a.due_date||"").localeCompare(b.due_date||"")), [state.special_requests, q]);

  const add = async () => {
    if (!form.event_id || !form.description) return alert("Evento y descripción son obligatorios");
    const item = { ...form, request_id: form.request_id || uid("R") } as SpecialRequest;
    setState({ ...state, special_requests: [item, ...state.special_requests] });
    try { await sbInsert<SpecialRequest>("special_requests", { ...item, owner_name: item.owner_name }); } catch (e:any) { alert(e.message); }
  };
  const toggle = async (id: string) => {
  const updated = state.special_requests.map(r =>
    r.request_id === id
      ? {
          ...r,
          status: (r.status === "open" ? "done" : "open") as SpecialRequest["status"],
        }
      : r
  );
  setState({ ...state, special_requests: updated });
  try {
    const target = updated.find(r => r.request_id === id)! as SpecialRequest;
    await sbUpdate<SpecialRequest>("special_requests", "request_id", target);
  } catch (e: any) {
    alert(e.message);
  }
};


  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Nueva solicitud" />
        <div className="space-y-2">
          <Select value={form.event_id} onChange={e=>setForm({...form, event_id: e.target.value})}>
            <option value="">— Evento —</option>
            {state.events.map(ev => <option key={ev.event_id} value={ev.event_id}>{fmtDate(ev.event_date)} · {ev.venue_name}</option>)}
          </Select>
          <Select value={form.category} onChange={e=>setForm({...form, category: e.target.value as any})}>
            <option value="photo">Foto</option>
            <option value="video">Video</option>
            <option value="other">Otro</option>
          </Select>
          <TextArea placeholder="Descripción" value={form.description} onChange={e=>setForm({...form, description: e.target.value})} />
          <Select value={form.priority} onChange={e=>setForm({...form, priority: e.target.value as any})}>
            <option value="low">Baja</option>
            <option value="medium">Media</option>
            <option value="high">Alta</option>
          </Select>
          <Input type="date" value={form.due_date||""} onChange={e=>setForm({...form, due_date: e.target.value})} />
          <Button onClick={add}>Agregar</Button>
        </div>
      </Card>

      <div className="md:col-span-2">
        <SectionHeader title="Solicitudes">
          <Input placeholder="Buscar…" value={q} onChange={e=>setQ(e.target.value)} className="w-56" />
        </SectionHeader>
        <div className="grid gap-3">
          {list.map(r => (
            <Card key={r.request_id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold line-clamp-1">{r.description}</div>
                  <div className="text-xs text-gray-500">{r.category} · Prioridad {r.priority} · {r.due_date?`Entrega ${fmtDate(r.due_date)}`:""}</div>
                </div>
                <div className="flex gap-2 items-center">
                  <Pill className={r.status==='open'?"border-orange-300":"border-green-300"}>{r.status}</Pill>
                  <Button onClick={()=>toggle(r.request_id)}>{r.status==='open'?"Marcar done":"Reabrir"}</Button>
                </div>
              </div>
            </Card>
          ))}
          {list.length===0 && <div className="text-gray-500">Sin solicitudes.</div>}
        </div>
      </div>
    </div>
  );
}

function TasksModule({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [form, setForm] = useState<Task>({ task_id: "", title: "", status: "todo" });
  const add = async () => {
    if (!form.title) return;
    const item = { ...form, task_id: form.task_id || uid("T") } as Task;
    setState({ ...state, tasks: [item, ...state.tasks] });
    try { await sbInsert<Task>("tasks", item); } catch (e:any) { alert(e.message); }
    setForm({ task_id: "", title: "", status: "todo" });
  };
  const toggle = async (id: string) => {
  const updated = state.tasks.map(t =>
    t.task_id === id
      ? {
          ...t,
          status: (t.status === "done" ? "todo" : "done") as Task["status"],
        }
      : t
  );
  setState({ ...state, tasks: updated });
  try {
    const target = updated.find(t => t.task_id === id)! as Task;
    await sbUpdate<Task>("tasks", "task_id", target);
  } catch (e: any) {
    alert(e.message);
  }
};


  const listTodo = state.tasks.filter(t=>t.status!=='done');
  const listDone = state.tasks.filter(t=>t.status==='done');

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Nueva tarea" />
        <div className="space-y-2">
          <Input placeholder="Título" value={form.title} onChange={e=>setForm({...form, title: e.target.value})} />
          <Input placeholder="Asignado a" value={form.assignee||""} onChange={e=>setForm({...form, assignee: e.target.value})} />
          <Input type="date" value={form.due_date||""} onChange={e=>setForm({...form, due_date: e.target.value})} />
          <Button onClick={add}>Agregar</Button>
        </div>
      </Card>

      <div className="md:col-span-2 grid md:grid-cols-2 gap-3">
        <Card>
          <h3 className="font-semibold mb-2">Pendientes</h3>
          <div className="space-y-2">
            {listTodo.map(t => (
              <div key={t.task_id} className="flex items-center justify-between border rounded-xl px-3 py-2">
                <div>
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-gray-500">{t.assignee} · {fmtDate(t.due_date)}</div>
                </div>
                <Button onClick={()=>toggle(t.task_id)}>Completar</Button>
              </div>
            ))}
            {listTodo.length===0 && <div className="text-gray-500">Sin pendientes.</div>}
          </div>
        </Card>
        <Card>
          <h3 className="font-semibold mb-2">Completadas</h3>
          <div className="space-y-2">
            {listDone.map(t => (
              <div key={t.task_id} className="flex items-center justify-between border rounded-xl px-3 py-2">
                <div>
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-gray-500">{t.assignee} · {fmtDate(t.due_date)}</div>
                </div>
                <button className="px-3 py-2 rounded-2xl border" onClick={()=>toggle(t.task_id)}>Reabrir</button>
              </div>
            ))}
            {listDone.length===0 && <div className="text-gray-500">Nada aún.</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}

function DeliverablesModule({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [form, setForm] = useState<Deliverable>({ deliverable_id: "", event_id: state.events[0]?.event_id || "", type: "sneak_peek" });
  const add = async () => {
    if (!form.event_id) return alert("Evento es obligatorio");
    const item = { ...form, deliverable_id: form.deliverable_id || uid("D") } as Deliverable;
    setState({ ...state, deliverables: [item, ...state.deliverables] });
    try { await sbInsert<Deliverable>("deliverables", item); } catch (e:any) { alert(e.message); }
  };
  const markDelivered = async (id: string) => {
    const updated = state.deliverables.map(d => d.deliverable_id===id? { ...d, delivered_date: todayISO() } : d);
    setState({ ...state, deliverables: updated });
    try { const target = updated.find(d=>d.deliverable_id===id)!; await sbUpdate<Deliverable>("deliverables", "deliverable_id", target); } catch (e:any) { alert(e.message); }
  }
  const remove = async (id: string) => {
    if (!confirm("¿Eliminar?")) return;
    setState({ ...state, deliverables: state.deliverables.filter(x=>x.deliverable_id!==id) });
    try { await sbDelete("deliverables", "deliverable_id", id); } catch (e:any) { alert(e.message); }
  }

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Nuevo entregable" />
        <div className="space-y-2">
          <Select value={form.event_id} onChange={e=>setForm({...form, event_id: e.target.value})}>
            <option value="">— Evento —</option>
            {state.events.map(ev => <option key={ev.event_id} value={ev.event_id}>{fmtDate(ev.event_date)} · {ev.venue_name}</option>)}
          </Select>
          <Select value={form.type} onChange={e=>setForm({...form, type: e.target.value as any})}>
            <option value="sneak_peek">Sneak Peek</option>
            <option value="slideshow">Slideshow</option>
            <option value="coming_soon">Coming Soon</option>
            <option value="highlight">Highlight</option>
            <option value="album">Álbum</option>
            <option value="photos">Fotos</option>
            <option value="other">Otro</option>
          </Select>
          <Input type="date" value={form.due_date||""} onChange={e=>setForm({...form, due_date: e.target.value})} />
          <Input placeholder="Link" value={form.link||""} onChange={e=>setForm({...form, link: e.target.value})} />
          <Button onClick={add}>Agregar</Button>
        </div>
      </Card>

      <div className="md:col-span-2">
        <SectionHeader title="Entregables" />
        <div className="grid gap-3">
          {state.deliverables.map(d => (
            <Card key={d.deliverable_id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{d.type} {d.link?"· link":""}</div>
                  <div className="text-xs text-gray-500">{fmtDate(d.due_date)} {d.delivered_date?`· Entregado ${fmtDate(d.delivered_date)}`:""}</div>
                </div>
                <div className="flex gap-2">
                  {!d.delivered_date && <Button onClick={()=>markDelivered(d.deliverable_id)}>Marcar entregado</Button>}
                  <button className="px-3 py-2 rounded-2xl border" onClick={()=>remove(d.deliverable_id)}>Eliminar</button>
                </div>
              </div>
            </Card>
          ))}
          {state.deliverables.length===0 && <div className="text-gray-500">Sin entregables.</div>}
        </div>
      </div>
    </div>
  );
}

function VendorsModule({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [form, setForm] = useState<Vendor>({ vendor_id: "", event_id: state.events[0]?.event_id || "", type: "planner", name: "" });
  const add = async () => {
    if (!form.event_id || !form.name) return alert("Evento y nombre son obligatorios");
    const item = { ...form, vendor_id: form.vendor_id || uid("V") } as Vendor;
    setState({ ...state, vendors: [item, ...state.vendors] });
    try { await sbInsert<Vendor>("vendors", item); } catch (e:any) { alert(e.message); }
  };
  const remove = async (id: string) => {
    if (!confirm("¿Eliminar?")) return;
    setState({ ...state, vendors: state.vendors.filter(x=>x.vendor_id!==id) });
    try { await sbDelete("vendors", "vendor_id", id); } catch (e:any) { alert(e.message); }
  }

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card>
        <SectionHeader title="Nuevo proveedor" />
        <div className="space-y-2">
          <Select value={form.event_id} onChange={e=>setForm({...form, event_id: e.target.value})}>
            <option value="">— Evento —</option>
            {state.events.map(ev => <option key={ev.event_id} value={ev.event_id}>{fmtDate(ev.event_date)} · {ev.venue_name}</option>)}
          </Select>
          <Select value={form.type} onChange={e=>setForm({...form, type: e.target.value as any})}>
            <option value="planner">Planner</option>
            <option value="dj">DJ</option>
            <option value="makeup">Makeup</option>
            <option value="venue">Venue</option>
            <option value="photo">Photo</option>
            <option value="video">Video</option>
            <option value="other">Otro</option>
          </Select>
          <Input placeholder="Nombre" value={form.name} onChange={e=>setForm({...form, name: e.target.value})} />
          <Input placeholder="Contacto" value={form.contact||""} onChange={e=>setForm({...form, contact: e.target.value})} />
          <TextArea placeholder="Notas" value={form.notes||""} onChange={e=>setForm({...form, notes: e.target.value})} />
          <Button onClick={add}>Agregar</Button>
        </div>
      </Card>

      <div className="md:col-span-2">
        <SectionHeader title="Proveedores" />
        <div className="grid gap-3">
          {state.vendors.map(v => (
            <Card key={v.vendor_id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{v.type}: {v.name}</div>
                  <div className="text-xs text-gray-500">{v.contact}</div>
                </div>
                <button className="px-3 py-2 rounded-2xl border" onClick={()=>remove(v.vendor_id)}>Eliminar</button>
              </div>
            </Card>
          ))}
          {state.vendors.length===0 && <div className="text-gray-500">Sin proveedores.</div>}
        </div>
      </div>
    </div>
  );
}

// =========================
// Tabs & App
// =========================
const tabs = [
  { id: "dashboard", label: "Dashboard" },
  { id: "clients", label: "Clientes" },
  { id: "events", label: "Eventos" },
  { id: "payments", label: "Pagos" },
  { id: "accounting", label: "Contabilidad" },
  { id: "requests", label: "Peticiones" },
  { id: "tasks", label: "Tareas" },
  { id: "deliverables", label: "Entregables" },
  { id: "vendors", label: "Proveedores" },
] as const;

type TabId = typeof tabs[number]["id"];

export default function App() {
  const { session, signIn, signOut } = useSupabaseAuth();
  const { state, setState, loading, error } = useStore(demo);
  const [tab, setTab] = useState<TabId>("dashboard");

  // Import / export / reset (solo afectan al estado local visible)
  const onImport = async (file: File) => {
    try { const text = await file.text(); const json = JSON.parse(text); setState(json); alert("Datos importados ✅"); } catch { alert("Archivo inválido"); }
  };
  const onExport = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `wedding-app-backup-${todayISO()}.json`; a.click(); URL.revokeObjectURL(url);
  };
  const onReset = () => { if (!confirm("Esto reseteará al demo local. ¿Continuar?")) return; setState(demo); };

  if (!supabase) {
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-2xl bg-black text-white flex items-center justify-center font-bold">EP</div>
              <div>
                <div className="font-semibold">Elegance Photographie — Admin</div>
                <div className="text-xs text-gray-500">MVP local (configura Supabase para la nube)</div>
              </div>
            </div>
            <Toolbar onImport={onImport} onExport={onExport} onReset={onReset} />
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 py-6">
          <div className="mb-6 p-4 border rounded-2xl bg-white">
            <div className="font-semibold mb-1">Configura Supabase</div>
            <ol className="list-decimal pl-5 text-sm space-y-1">
              <li>En Supabase crea un proyecto y ejecuta el <code>SCHEMA_SQL</code> (lo tienes en el código).</li>
              <li>Agrega <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code> a tu entorno.</li>
              <li>Recarga la app: verás login y datos en la nube.</li>
            </ol>
          </div>
          <nav className="flex flex-wrap gap-2 mb-6">
            {tabs.map(t => (<button key={t.id} onClick={()=>setTab(t.id)} className={`px-4 py-2 rounded-2xl border ${tab===t.id?"bg-black text-white":"bg-white"}`}>{t.label}</button>))}
          </nav>
          {loading && <div className="text-sm text-gray-600">Cargando…</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {/* Render local demo modules */}
          {tab==="dashboard" && <Dashboard state={state} />}
          {tab==="clients" && <ClientsModule state={state} setState={setState} />}
          {tab==="events" && <EventsModule state={state} setState={setState} />}
          {tab==="payments" && <PaymentsModule state={state} setState={setState} />}
          {tab==="accounting" && <AccountingModule state={state} />}
          {tab==="requests" && <RequestsModule state={state} setState={setState} />}
          {tab==="tasks" && <TasksModule state={state} setState={setState} />}
          {tab==="deliverables" && <DeliverablesModule state={state} setState={setState} />}
          {tab==="vendors" && <VendorsModule state={state} setState={setState} />}
        </main>
        <footer className="max-w-6xl mx-auto px-4 py-6 text-xs text-gray-500">Añade a pantalla de inicio (PWA). Con Supabase tendrás nube + tiempo real + auth.</footer>
      </div>
    );
  }

  if (!session) {
    let email = "";
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900 flex items-center justify-center p-6">
        <div className="max-w-md w-full p-6 bg-white rounded-2xl shadow">
          <div className="text-lg font-semibold mb-2">Iniciar sesión</div>
          <div className="text-sm text-gray-600 mb-4">Escribe tu correo para recibir un Magic Link.</div>
          <Input type="email" placeholder="tu@email.com" onChange={(e)=>{ email = e.target.value }} />
          <div className="mt-3"><Button onClick={()=> (email? signIn(email): alert("Escribe tu correo"))}>Enviar Magic Link</Button></div>
          <div className="text-xs text-gray-500 mt-3">Configura dominios permitidos en Auth {'>'}

 URL</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-black text-white flex items-center justify-center font-bold">EP</div>
            <div>
              <div className="font-semibold">Elegance Photographie — Admin</div>
              <div className="text-xs text-gray-500">Conectado a Supabase — {session?.user?.email}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Toolbar onImport={onImport} onExport={onExport} onReset={onReset} />
            <button className="px-3 py-2 rounded-2xl border" onClick={signOut}>Salir</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <nav className="flex flex-wrap gap-2 mb-6">
          {tabs.map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)} className={`px-4 py-2 rounded-2xl border ${tab===t.id?"bg-black text-white":"bg-white"}`}>{t.label}</button>
          ))}
        </nav>

        {/* Modulos conectados (usan el mismo setState optimista y escriben en Supabase) */}
        {tab==="dashboard" && <Dashboard state={state} />}
        {tab==="clients" && <ClientsModule state={state} setState={setState} />}
        {tab==="events" && <EventsModule state={state} setState={setState} />}
        {tab==="payments" && <PaymentsModule state={state} setState={setState} />}
        {tab==="accounting" && <AccountingModule state={state} />}
        {tab==="requests" && <RequestsModule state={state} setState={setState} />}
        {tab==="tasks" && <TasksModule state={state} setState={setState} />}
        {tab==="deliverables" && <DeliverablesModule state={state} setState={setState} />}
        {tab==="vendors" && <VendorsModule state={state} setState={setState} />}
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-6 text-xs text-gray-500">
        Consejos: activa Storage (para contratos/fotos), agrega Policies por rol si sumas equipo, y usa Webhooks para recordatorios automáticos.
      </footer>
    </div>
  );
}
