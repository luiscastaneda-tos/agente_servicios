import type {
  TransportServiceType,
  WebSearchResultItem,
} from "../../types/index";
import type {
  ITransportServiceRepository,
  IWebSearchRepository,
  TransportSearchQuery,
} from "../interfaces/repositories.interface";

abstract class BaseTransportRepository implements ITransportServiceRepository {
  public abstract readonly serviceType: TransportServiceType;

  constructor(protected readonly webSearchRepo: IWebSearchRepository) {}

  protected abstract buildSearchQueries(query: TransportSearchQuery): string[];

  public async searchServiceInfo(query: TransportSearchQuery): Promise<{
    rawSearchContext: string;
    webSources: WebSearchResultItem[];
  }> {
    const queries = this.buildSearchQueries(query);
    const allResults: WebSearchResultItem[] = [];
    const seenUrls = new Set<string>();

    for (const q of queries) {
      const results = await this.webSearchRepo.searchWeb(q, 5);
      for (const item of results) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          allResults.push(item);
        }
      }
    }

    const rawSearchContext =
      allResults.length > 0
        ? allResults
            .map(
              (item, idx) =>
                `[Fuente Web #${idx + 1}] Título: ${item.title}\nURL: ${item.url}\nExtracto: ${item.snippet}`
            )
            .join("\n\n")
        : "No se encontraron resultados web directos en este momento; utiliza conocimiento verificado de operadores reales para la ruta solicitada.";

    return {
      rawSearchContext,
      webSources: allResults.slice(0, 8),
    };
  }
}

export class FlightRepository extends BaseTransportRepository {
  public readonly serviceType: TransportServiceType = "flight";

  protected buildSearchQueries(query: TransportSearchQuery): string[] {
    const origin = query.origin || "Ciudad de México";
    const destination = query.destination || "";
    const datePart = query.date ? ` ${query.date}` : "";
    if (destination) {
      return [
        `vuelos directos aerolíneas de ${origin} a ${destination} duración aeropuertos horarios${datePart}`,
        `flights from ${origin} to ${destination} airlines non-stop duration`,
      ];
    }
    return [
      `principales aerolíneas vuelos desde ${origin} rutas nacionales e internacionales`,
    ];
  }
}

export class CarRentalRepository extends BaseTransportRepository {
  public readonly serviceType: TransportServiceType = "car_rental";

  protected buildSearchQueries(query: TransportSearchQuery): string[] {
    const location = query.destination || query.origin || "México";
    const extra = query.extraContext ? ` ${query.extraContext}` : "";
    return [
      `renta de autos en ${location} agencias aeropuerto requisitos tarifas seguros${extra}`,
      `car rental companies ${location} airport fleet SUV sedan requirements`,
    ];
  }
}

export class ChauffeurRepository extends BaseTransportRepository {
  public readonly serviceType: TransportServiceType = "chauffeur";

  protected buildSearchQueries(query: TransportSearchQuery): string[] {
    const origin = query.origin || "Ciudad de México";
    const destination = query.destination || "";
    const route = destination ? `de ${origin} a ${destination}` : `en ${origin}`;
    return [
      `transporte ejecutivo privado con chofer ${route} camionetas van sedán traslado aeropuerto`,
      `private chauffeur service executive transfer ${origin} ${destination}`,
    ];
  }
}

export class FerryRepository extends BaseTransportRepository {
  public readonly serviceType: TransportServiceType = "ferry";

  protected buildSearchQueries(query: TransportSearchQuery): string[] {
    const origin = query.origin || "";
    const destination = query.destination || "";
    const route =
      origin && destination
        ? `${origin} a ${destination}`
        : destination || origin || "Cozumel Isla Mujeres Baja California";
    return [
      `ferry transbordador marítimo ${route} operadores horarios puertos duración boletos`,
      `ferry schedule operators ${route} port terminal duration`,
    ];
  }
}

export class TrainRepository extends BaseTransportRepository {
  public readonly serviceType: TransportServiceType = "train";

  protected buildSearchQueries(query: TransportSearchQuery): string[] {
    const origin = query.origin || "";
    const destination = query.destination || "";
    const route =
      origin && destination
        ? `de ${origin} a ${destination}`
        : destination || origin || "Tren Maya Chepe Europa";
    return [
      `tren de pasajeros ${route} estaciones horarios rutas clases duración`,
      `passenger train ${route} rail operators stations schedule duration`,
    ];
  }
}

export class BusRepository extends BaseTransportRepository {
  public readonly serviceType: TransportServiceType = "bus";

  protected buildSearchQueries(query: TransportSearchQuery): string[] {
    const origin = query.origin || "Ciudad de México";
    const destination = query.destination || "";
    const route = destination ? `de ${origin} a ${destination}` : `desde ${origin}`;
    return [
      `autobuses ${route} líneas ejecutivas ETN ADO Primera Plus Futura terminales horarios duración`,
      `intercity bus ${origin} ${destination} terminal schedule duration`,
    ];
  }
}
