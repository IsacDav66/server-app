// Archivo: /server/middleware/uploadPost.js (ACTUALIZADO)

const multer = require('multer');

// 1. Usar almacenamiento en memoria
const storage = multer.memoryStorage();

// 2. Filtro de archivos (sin cambios)
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen.'), false);
    }
};

// 3. Inicializar Multer
const uploadPost = multer({ 
    storage: storage,
    limits: { 
        fileSize: 10 * 1024 * 1024 // Limite de 10MB
    },
    fileFilter: fileFilter
});

// Exporta el middleware (sin cambios)
module.exports = uploadPost.single('postImage');