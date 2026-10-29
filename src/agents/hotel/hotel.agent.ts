import { HotelServiceRepository } from "../../repositories/hotel-service.repository";
import { HotelFoundOption, HotelQuoteItem } from "../../types";

// A diferencia de BaseTransportSpecialistAgent, este agente no extiende esa clase ni
// llama a un LLM: esa clase asume búsqueda web en texto libre que hay que estructurar
// con IA, mientras que el microservicio de hoteles ya devuelve JSON estructurado. Solo
// queda mapear, así que un wrapper delgado alrededor del repositorio es suficiente.
export class HotelAgent {
  constructor(
    private readonly repository: HotelServiceRepository = new HotelServiceRepository()
  ) {}

  public async search(item: HotelQuoteItem): Promise<HotelFoundOption[]> {
    if (!item.city || !item.checkIn || !item.checkOut) return [];

    // `rooms`/`guests` de HotelSearchQuery no se usan en el repositorio (ver
    // buildOccupancy: las variantes de cuarto son previsualizaciones fijas, no la
    // reserva real del cliente), así que no hay nada que mapear desde el nuevo
    // `item.rooms` (arreglo de habitaciones) hacia ellos.
    return this.repository.searchHotels(item.id, {
      city: item.city,
      checkIn: item.checkIn,
      checkOut: item.checkOut,
    });
  }
}
