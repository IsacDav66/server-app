// Archivo: /server/api/worlds.js

const express = require('express');
const { protect } = require('../middleware/auth'); // Importamos el middleware de autenticación

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    /**
     * @route   POST /api/worlds/announce
     * @desc    Anuncia un mundo o actualiza uno existente.
     * @access  Privado
     */
    router.post('/announce', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const hostUserId = req.user.userId;
        const { worldName, playerCount, maxPlayers, gameVersion } = req.body;

        // Validar que el nombre del mundo no esté vacío
        if (!worldName) {
            return res.status(400).json({ success: false, message: 'El nombre del mundo es requerido.' });
        }

        // Obtener la IP y puerto públicos del cliente que hace la petición.
        // req.ip puede variar si estás detrás de un proxy (como Nginx).
        // req.connection.remoteAddress es a menudo más directo.
        const publicIp = req.ip || req.connection.remoteAddress;
        const publicPort = req.connection.remotePort;

        try {
            // Esta consulta es atómica: inserta una nueva fila. Si ya existe una fila
            // para este host_user_id (debido a la restricción UNIQUE), la actualiza.
            const query = `
                INSERT INTO active_worlds (host_user_id, world_name, player_count, max_players, game_version, public_ip, public_port, last_seen)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                ON CONFLICT (host_user_id)
                DO UPDATE SET
                    world_name = EXCLUDED.world_name,
                    player_count = EXCLUDED.player_count,
                    max_players = EXCLUDED.max_players,
                    game_version = EXCLUDED.game_version,
                    public_ip = EXCLUDED.public_ip,
                    public_port = EXCLUDED.public_port,
                    last_seen = NOW();
            `;

            await pool.query(query, [
                hostUserId,
                worldName,
                playerCount || 0,
                maxPlayers || 8,
                gameVersion || 'N/A',
                publicIp,
                publicPort
            ]);

            res.status(200).json({ success: true, message: 'Mundo anunciado/actualizado correctamente.' });

        } catch (error) {
            console.error('Error al anunciar el mundo:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    /**
     * @route   POST /api/worlds/unannounce
     * @desc    Retira un mundo de la lista de mundos activos.
     * @access  Privado
     */
    router.post('/unannounce', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const hostUserId = req.user.userId;

        try {
            const result = await pool.query('DELETE FROM active_worlds WHERE host_user_id = $1', [hostUserId]);
            
            if (result.rowCount === 0) {
                 return res.status(200).json({ success: true, message: 'No había ningún mundo que desanunciar.' });
            }

            res.status(200).json({ success: true, message: 'Mundo retirado de la lista.' });
        } catch (error) {
            console.error('Error al retirar el mundo:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    /**
     * @route   GET /api/worlds
     * @desc    Obtiene la lista de mundos activos, purgando los antiguos.
     * @access  Privado
     */
    router.get('/', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            // Paso 1: Purgar mundos que no han reportado actividad en los últimos 2 minutos.
            // Este intervalo asegura que si un jugador cierra el juego de golpe, su mundo no se quede "fantasma".
            await pool.query("DELETE FROM active_worlds WHERE last_seen < NOW() - INTERVAL '2 minutes'");

            // Paso 2: Obtener la lista de mundos restantes.
            const result = await pool.query('SELECT * FROM active_worlds ORDER BY last_seen DESC');

            res.status(200).json({ success: true, worlds: result.rows });
        } catch (error) {
            console.error('Error al obtener la lista de mundos:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    return router;
};