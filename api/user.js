// Archivo: /server/api/user.js

const express = require('express');
const { protect } = require('../middleware/auth'); 

module.exports = (pool) => {
    const router = express.Router();

    // ----------------------------------------------------
    // RUTA PROTEGIDA: Manejo explícito del OPTIONS de CORS
    // El navegador lo envía antes de GET/POST.
    // ----------------------------------------------------
    router.options('/me', (req, res) => {
        // El navegador espera una respuesta 200 o 204 para saber que puede enviar el GET
        res.sendStatus(200); 
    });

    // ----------------------------------------------------
    // RUTA PROTEGIDA: Obtener datos del usuario (requiere token)
    // ----------------------------------------------------
    router.get('/me', protect, async (req, res) => { // <-- ¡APLICAR EL PROTECT AQUÍ!
        
        // Si llegamos aquí, el middleware 'protect' verificó la cookie y cargó req.user.userId
        
        try {
            // Buscamos el email para la respuesta usando el ID que la sesión nos dio
            const query = 'SELECT email FROM usersapp WHERE id = $1';
            const result = await pool.query(query, [req.user.userId]);

            if (result.rows.length === 0) {
                 // Esto no debería suceder si la sesión es válida, pero es una buena práctica
                return res.status(404).json({ success: false, message: 'Usuario no encontrado en DB.' });
            }

            res.status(200).json({
                success: true,
                message: 'Acceso a la ruta protegida concedido.',
                data: {
                    userId: req.user.userId,
                    email: result.rows[0].email,
                }
            });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error al obtener datos del usuario.' });
        }
        // ... (Tu lógica de obtención de usuario) ...
    });

    return router;
};