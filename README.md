# FUNEKES · Landing + venta de entradas

Landing de Funekes (Tomé) con compra de entradas por transferencia y panel de administrador.
HTML + CSS + JS sin build. Backend: Supabase.

- `index.html`: landing y compra (elige tramo y cantidad, completa los datos de cada entrada y pide los datos de transferencia por WhatsApp)
- `admin.html`: panel (órdenes pendientes/pagadas, precios, eventos, contacto)
- `supabase/schema.sql`: tablas, RLS, RPC `create_order` y datos iniciales
- `docs/PROMPT.md`: prompt usado para construirlo

## Probar ya (modo demo)

```bash
python3 -m http.server 8000
```

Abre `http://localhost:8000`. Para entrar al admin (`/admin.html`) sirve cualquier correo y contraseña.
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
5. En Vercel: **Add New → Project**, importa el repo y en **Framework Preset** elige **Other**.
6. En **Environment Variables** agrega:
   - `SUPABASE_URL`: Project URL (Supabase → Project Settings → API)
   - `SUPABASE_ANON_KEY`: anon public key
7. Presiona **Deploy**. El build (`vercel.json`) escribe esas variables en `js/config.js`.
   Si faltan, el deploy de producción falla a propósito para que no quede en modo demo.
8. En el admin, abre **Contacto** y revisa el WhatsApp (viene con +56 9 5989 7604).

Si cambias las variables después, haz **Redeploy** para que se apliquen.

## Cómo funciona la venta

1. El comprador elige cantidad (en preventa es 1 entrada por persona; en Puerta, hasta 10).
2. Completa nombre y apellido de **cada** entrada.
3. Se crea la orden `pendiente` con un código (ej. `FNK-7Q2KX`). El precio lo calcula la base de datos, no el navegador.
4. Toca **Pedir datos por WhatsApp**: se abre un chat con el dueño con el código, las entradas y el total ya escritos.
5. El dueño le responde con los datos de transferencia y recibe el comprobante por el mismo chat.
6. En el admin, el dueño busca el código y marca la orden como **Pagado**.

## Seguridad

- Nadie del público puede ver órdenes ni datos de otros compradores (RLS).
- Las compras solo se crean con la función `create_order`, que valida el tramo, el cupo y el precio. Los tramos se venden en orden (al agotarse uno se abre el siguiente) y el cupo nunca se expone al público.
- La `anon key` es pública por diseño. **Nunca** pongas la `service_role` key en el código.

## Imágenes

Las fotos de `assets/img/` salen de la captura de referencia y tienen baja resolución. Reemplázalas por los originales.
Cuando un evento no tiene foto, la web genera un afiche tipográfico.
