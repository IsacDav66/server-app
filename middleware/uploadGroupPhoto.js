const multer = require('multer');

// Usamos almacenamiento en memoria para procesarlo luego con Sharp
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 5 * 1024 * 1024 // Límite de 5MB
    },
    fileFilter: fileFilter
});

module.exports = upload.single('groupPhoto');