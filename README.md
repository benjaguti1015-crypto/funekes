# FUNEKES · Landing + venta de entradas

Landing de Funekes (Tomé) con compra de entradas por transferencia y panel de administrador.
HTML + CSS + JS sin build. Backend: Supabase.

- `index.html`: landing y compra (elige tramo y cantidad, completa los datos de cada entrada y pide los datos de transferencia por WhatsApp)
- `admin.html`: panel (órdenes pendientes/pagadas, QR y PDF de cada entrada, traspasos, precios, eventos, contacto)
- `puerta.html`: escáner de QR para el guardia en la entrada (cuenta propia, solo valida entradas)
- `terminos.html` y `privacidad.html`: términos y condiciones y política de privacidad
- `supabase/schema.sql`: tablas, RLS, funciones (`create_order`, `check_in`, `transfer_ticket`) y datos iniciales
- `supabase/actualizacion.sql`: actualización corta para una base que ya tiene `schema.sql` (aceptación de términos, vencimiento a 24 horas, largo máximo de nombres)
- `js/vendor/`: librerías incluidas en el repo (Supabase, generar QR, crear PDF y leer QR con la cámara), todas con licencia MIT
- `docs/PROMPT.md`: prompt usado para construirlo

## Probar ya (modo demo)

```bash
npx serve .
```

Abre `http://localhost:3000`. Para entrar al admin (`/admin`) o al escáner (`/puerta`) sirve cualquier correo y contraseña.

Las direcciones van sin `.html` (`/admin`, `/puerta`, `/terminos`, `/privacidad`): Vercel lo hace con `cleanUrls` en `vercel.json`, y si alguien escribe `/admin.html` lo redirige a `/admin`.
Los datos se guardan solo en tu navegador.

## Conectar Supabase (producción)

1. Crea un proyecto en supabase.com.
2. Ve a **SQL Editor**, pega `supabase/schema.sql` completo y presiona **Run**.
3. Ve a **Authentication → Users → Add user** y crea el usuario del administrador.
4. En el SQL Editor corre lo siguiente, con su correo:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'CORREO_DEL_ADMIN';
   ```
5. Crea la cuenta del guardia igual: **Add user** con su correo y contraseña, y después corre:
   ```sql
   insert into public.guards (user_id)
   select id from auth.users where email = 'CORREO_DEL_GUARDIA'
   on conflict do nothing;
   ```
   Esa cuenta entra a `/puerta` y solo puede escanear: no ve ventas, precios ni la lista de compradores.
6. En Vercel: **Add New → Project**, importa el repo y en **Framework Preset** elige **Other**.
7. En **Environment Variables** agrega:
   - `SUPABASE_URL`: Project URL (Supabase → Project Settings → API)
   - `SUPABASE_ANON_KEY`: anon public key
8. Presiona **Deploy**. El build (`vercel.json`) escribe esas variables en `js/config.js`.
   Si faltan, el deploy de producción falla a propósito para que no quede en modo demo.
9. En el admin, abre **Contacto** y revisa el WhatsApp (viene con +56 9 5989 7604).

Si cambias las variables después, haz **Redeploy** para que se apliquen.

`supabase/schema.sql` se puede volver a pegar completo cada vez que cambie: actualiza la base sin borrar órdenes.

## Cómo funciona la venta

1. El comprador ve los tramos. Solo se vende uno a la vez y en preventa es 1 entrada por persona. "Puerta" se muestra con su precio pero no se vende en la web: es efectivo en la entrada.
2. Completa nombre y apellido de **cada** entrada y marca la casilla de aceptación de términos, privacidad y mayoría de edad (es obligatoria).
3. Se crea la orden `pendiente` con un código (ej. `FNK-7Q2KX`). El precio lo calcula la base de datos, no el navegador.
   La orden reserva el cupo **24 horas**. Si no se paga, se cancela sola y el cupo queda libre (se revisa en cada compra y cada vez que abres el admin). Si alguien paga tarde, en el admin puedes **Reactivar** la orden: vuelve a pendiente con 24 horas nuevas.
4. Toca **Pedir datos por WhatsApp**: se abre un chat con el dueño con el código, las entradas y el total ya escritos.
5. El dueño le responde con los datos de transferencia y recibe el comprobante por el mismo chat.
6. En el admin, el dueño busca el código y marca la orden como **Pagado**. Desde ese momento el QR de la entrada es válido.
7. En la fila de la orden pagada toca **Entrada PDF**: se descarga un PDF con el logo, el nombre y el QR. Ese archivo se lo manda al comprador por WhatsApp.

## El día del evento

1. El guardia abre `/puerta` en su celular, entra con su cuenta y da permiso a la cámara.
2. Apunta al QR. La pantalla se pone **verde** (Adelante, con el nombre) o **roja** (ya ingresó, no pagada, cancelada, de otro evento o QR no válido).
3. Cada QR sirve una sola vez. Si la cámara no lo lee, se puede escribir el código de 12 caracteres que sale debajo del QR.
4. Necesita internet: cada escaneo se valida contra la base de datos.

En el admin, cada entrada muestra si ya ingresó y a qué hora, y se puede **deshacer un ingreso** marcado por error.

## Traspasos

Las entradas no tienen devolución, pero se pueden traspasar por WhatsApp, **solo si lo piden desde el mismo número de teléfono con el que se pagó**. En el admin, abre la orden y toca **Traspasar**:
escribe el nombre y apellido de quien la recibe. Se genera un QR nuevo y el anterior deja de servir, así que hay que descargar el PDF otra vez.

## Seguridad

- Nadie del público puede ver órdenes ni datos de otros compradores (RLS).
- Las compras solo se crean con la función `create_order`, que valida el tramo, el cupo y el precio. Los tramos se venden en orden (al agotarse uno se abre el siguiente) y el cupo nunca se expone al público.
- El QR lleva solo un código al azar de 12 caracteres, sin datos personales. Validarlo exige una cuenta de guardia o de admin.
- El guardia no puede leer las tablas de órdenes ni de entradas: solo llama a la función `check_in`, que responde por un código a la vez.
- Las órdenes sin pagar vencen a las 24 horas: nadie puede bloquear la venta con reservas falsas por más de un día.
- Todas las librerías se sirven desde el propio sitio (sin CDN externos de código).
- `vercel.json` agrega cabeceras de seguridad: CSP (solo se ejecuta código del propio sitio y solo se conecta a Supabase), no se puede meter el sitio dentro de otra página, HTTPS obligatorio, y la cámara solo para el escáner.
- En Supabase → Authentication → Sign In / Providers conviene dejar apagado "Allow new users to sign up": las cuentas las creas tú desde el panel.
- La `anon key` es pública por diseño. **Nunca** pongas la `service_role` key en el código.

## Imágenes

El logo de los PDF es `assets/img/logo-funekes.jpg`. Para cambiarlo, reemplaza ese archivo por uno cuadrado con fondo negro (idealmente de 600 px o más).

Las fotos de `assets/img/` salen de la captura de referencia y tienen baja resolución. Reemplázalas por los originales.
Cuando un evento no tiene foto, la web genera un afiche tipográfico.
