// Los tests no deben llenar la consola de lineas de log; los que verifican logs usan logger.setSink().
process.env.LOG_SILENT = "1";
