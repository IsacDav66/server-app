// Archivo: /server/middleware/uploadVideo.js

const multer = require('multer');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    // ¡LA LÍNEA CLAVE! Ahora aceptamos cualquier tipo de video.
    if (file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        // Mensaje de error actualizado para ser más específico
        cb(new Error('Solo se permiten archivos de video.'), false);
    }
};

const uploadVideo = multer({ 
    storage: storage,
    limits: { 
        fileSize: 50 * 1024 * 1024 // Limite de 50MB (puedes ajustarlo)
    },
    fileFilter: fileFilter
});

// El backend espera el archivo en el campo 'postImage', así que lo mantenemos
module.exports = uploadVideo.single('postImage');