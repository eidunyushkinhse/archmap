const API_URL = process.env.API_URL || 'http://orders:8080';

export function fetchOrder(id) {
  return fetch(`${API_URL}/api/orders/${id}`).then((r) => r.json());
}
