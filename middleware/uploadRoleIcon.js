// Archivo: /server/middleware/uploadRoleIcon.js
const multer = require('multer');

// Usamos almacenamiento en memoria para que el middleware 'processImage' pueda usar el buffer
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    // Aceptamos imágenes y GIFs
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen para el icono del rol.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 2 * 1024 * 1024 // Límite de 2MB para un icono pequeño
    },
    fileFilter: fileFilter
});

// Exportamos configurado para buscar el campo 'roleIcon'
module.exports = upload.single('roleIcon');