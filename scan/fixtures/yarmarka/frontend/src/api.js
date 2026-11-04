const API_URL = process.env.API_URL || 'http://orders:8080';
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 20);

export function fetchOrder(id) {
  return fetch(`${API_URL}/api/orders/${id}?limit=${PAGE_SIZE}`).then((r) => r.json());
}
