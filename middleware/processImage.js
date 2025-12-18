// Archivo: /server/middleware/processImage.js

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

/**
 * Middleware para procesar una imagen subida, convertirla a WebP y guardarla.
 * @param {string} type - El tipo de imagen ('profile' o 'post') para generar el prefijo del nombre.
 */
const processImage = (type) => async (req, res, next) => {
    // Si no se subió ningún archivo, continuar.
    if (!req.file) {
        return next();
    }

    // 1. Definir la carpeta de destino según el tipo
    let folder = 'default';
    if (type === 'profile') folder = 'profile_images';
    if (type === 'post') folder = 'post_images';
    if (type === 'cover') folder = 'cover_images'; // <-- AÑADIR ESTA LÍNEA
    if (type === 'bio') folder = 'bio_images';
    if (type === 'card_cover') folder = 'card_cover_images';
    const destinationPath = path.join(__dirname, `../uploads/${folder}/`);

    // 2. Asegurarse de que el directorio exista
    fs.mkdirSync(destinationPath, { recursive: true });

    // 3. Generar un nuevo nombre de archivo con la extensión .webp
    const originalName = path.parse(req.file.originalname).name;
    const userId = req.user.userId;
    const timestamp = Date.now();
    // Ejemplo: profile_3_1760135569135.webp
    const newFilename = `${type}_${userId}_${timestamp}.webp`;
    const fullFilePath = path.join(destinationPath, newFilename);

    try {
        // 4. Usar Sharp para procesar el buffer de la imagen en memoria
        await sharp(req.file.buffer)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true }) // Redimensiona si es muy grande (opcional)
            .webp({ quality: 80 }) // Convierte a WebP con 80% de calidad
            .toFile(fullFilePath); // Guarda el archivo procesado

        // 5. IMPORTANTE: Actualizar el objeto req.file con la nueva información
        // para que la siguiente función (la ruta principal) la pueda usar.
        req.file.filename = newFilename;
        req.file.path = fullFilePath;
        req.file.destination = destinationPath;

        next(); // Continuar a la siguiente función en la ruta

    } catch (error) {
        console.error('❌ Error al procesar la imagen con Sharp:', error);
        return res.status(500).json({ success: false, message: 'Error al procesar la imagen.' });
    }
};

module.exports = processImage;