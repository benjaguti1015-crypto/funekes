# FUNEKES · Landing + venta de entradas

Landing de Funekes (Tomé) con compra de entradas por transferencia y panel de administrador.
HTML + CSS + JS sin build. Backend: Supabase.

- `index.html`: landing y compra (elige tramo y cantidad, completa los datos de cada entrada y recibe los datos de transferencia)
- `admin.html`: panel (órdenes pendientes/pagadas, precios, eventos, datos de pago)
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
5. Ve a **Project Settings → API**, copia `Project URL` y la `anon public key` y pégalas en `js/config.js`.
6. En el admin, abre **Datos de pago** y pon los datos bancarios reales.
7. Publica la carpeta en Vercel, Netlify o GitHub Pages. Es un sitio estático.

## Cómo funciona la venta

1. El comprador elige tramo y cantidad (1 a 10).
2. Completa nombre, apellido y correo de **cada** entrada.
3. Se crea la orden `pendiente` con un código (ej. `FNK-7Q2KX`). El precio lo calcula la base de datos, no el navegador.
4. Transfiere y pone el código en el comentario.
5. En el admin, el organizador marca la orden como **Pagado**.

## Seguridad

- Nadie del público puede ver órdenes ni datos de otros compradores (RLS).
- Las compras solo se crean con la función `create_order`, que valida el tramo, el cupo, los correos y el precio.
- La `anon key` es pública por diseño. **Nunca** pongas la `service_role` key en el código.

## Imágenes

Las fotos de `assets/img/` salen de la captura de referencia y tienen baja resolución. Reemplázalas por los originales.
Cuando un evento no tiene foto, la web genera un afiche tipográfico.
