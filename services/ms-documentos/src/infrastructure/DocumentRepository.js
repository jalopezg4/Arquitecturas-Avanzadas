const Document = require("../domain/Document");

class DocumentRepository {
  async create(data) {
    return Document.create(data);
  }

  async findById(id) {
    return Document.findById(id);
  }

  async markEventPublished(id) {
    await Document.updateOne({ _id: id }, { eventoPublicado: true });
  }
}

module.exports = DocumentRepository;
