# Prompt — Funekes (Claude Code)

```
Eres un ingeniero full-stack y design engineer senior. Construye desde cero, en el repo actual
(vacío), la web de FUNEKES: productora de fiestas en Tomé, Biobío (Chile). Es landing page +
venta de entradas por transferencia + panel de administrador, con Supabase como backend.

<referencia_visual>
Usa la captura adjunta como fuente visual bloqueada (no reinterpretar):
- Fondo casi negro (#0e0e0f), superficies #151516, bordes 1px finos, acento coral/rojo (#ff4a3d)
  SOLO en CTAs, etiquetas y la franja "Próxima fecha". Texto hueso (#f4efe8).
- Titulares grotesk extra-bold en mayúsculas, muy grandes y apretados ("FUNEKES", "PRÓXIMO EVENTO").
  Etiquetas en monoespaciada pequeña con tracking amplio y guion rojo ("— AGENDA").
- Secciones en este orden: nav (logo corona + links + botón "Entradas") → hero con foto roja y
  "FUNEKES / La noche es de Tomé." → franja roja "Próxima fecha · CHAO CLASES 2026 · SÁB 12 DIC"
  → Próximo evento (tarjeta foto + info + precios) → Archivo (Halloween 31 oct, 500+ asistentes,
  2 afiches) → "Hecho en Tomé." + Instagram/WhatsApp → footer.
- Fotos: usa las de /assets/img. Si falta una imagen, crea un afiche tipográfico en CSS, nunca un recuadro gris.
</referencia_visual>

<cambio_clave>
Donde la captura dice "Consultar por WhatsApp", va "Comprar entrada". Evento demo: CHAO CLASES 2026,
sábado 12/12/2026, Tomé. Tramos: Preventa 1 $4.000 · Preventa 2 $5.000 · General $7.000.
</cambio_clave>

<flujo_compra>
1. Elegir tramo y cantidad (1–10).
2. Por CADA entrada: nombre, apellido y correo (N bloques de formulario según la cantidad).
3. Confirmar → se crea la orden "pendiente" con un código corto (ej. FNK-7Q2K) y se muestran
   los datos de transferencia + total + instrucción de poner el código en el comentario.
El precio SIEMPRE se calcula en el servidor (RPC), nunca se confía en el cliente.
</flujo_compra>

<supabase>
Entrega supabase/schema.sql idempotente con: events, ticket_tiers, orders, tickets, settings
(datos bancarios), admins; función is_admin(); RPC create_order (security definer, valida tramo
activo y cupo, calcula total); RLS: público lee eventos publicados, tramos activos y settings;
público NO lee órdenes; admins leen/escriben todo. Seed con Chao Clases 2026 y Halloween (archivo).
</supabase>

<admin>
admin.html con login Supabase Auth (email/contraseña). Funciones: ver órdenes con filtro y
búsqueda, marcar pendiente → pagado (y cancelar), editar precios/tramos, crear/editar eventos,
editar datos bancarios, KPIs (vendidas, pagadas, recaudado, pendiente por cobrar).
</admin>

<restricciones>
- Stack: HTML + CSS + JS vanilla (ES modules), supabase-js v2 por CDN con versión fija. Sin build.
- Si config.js no tiene credenciales: modo demo con datos locales (localStorage) para presentar.
- Movimiento: solo transform/opacity, ease-out cubic-bezier(0.23,1,0.32,1), <300ms en UI,
  :active scale(0.97) en botones, hover tras @media (hover:hover), respeta prefers-reduced-motion.
- Responsive 375px → 1440px, sin scroll horizontal. Accesible (labels, focus visible, contraste AA).
- No agregues pasarela de pago, newsletter, blog ni features no pedidas.
- Nunca pongas llaves reales en el código: usa placeholders en js/config.js.
</restricciones>

<entregables>
index.html, admin.html, css/, js/ (config, data, app, admin), supabase/schema.sql, README.md con
pasos de puesta en marcha en Supabase.
</entregables>

<verificacion>
Listo cuando: (1) la landing se ve como la captura en 1440px y 375px (captura con Playwright),
(2) en modo demo se puede comprar 3 entradas y aparecen 3 formularios, (3) la orden aparece en
el admin y se puede marcar pagada, (4) el SQL corre sin errores en Postgres 15.
Después de cada paso muestra: ✅ [lo completado]. Detente y pregunta antes de borrar archivos o
agregar dependencias npm.
</verificacion>
```

🎯 Target: Claude Code · 💡 Bloquea la captura como referencia visual, fija el precio en el servidor y define un "listo cuando" verificable para evitar iteraciones.
