export const JSON_HEADERS = { "Content-Type": "application/json" };
export const GET_JSON_REQUEST = { method: "GET", headers: JSON_HEADERS };
export const POST_JSON_REQUEST = { method: "POST", headers: JSON_HEADERS };

export function makeID() {
  return Date.now();
}

export function getEmail() {
  let email = localStorage.getItem("user_email");
  if (email && email !== "null") return email;
  email = prompt("Please enter your email");
  localStorage.setItem("user_email", email);
  return email;
}

export function clearEmail() {
  localStorage.removeItem("user_email");
}

export function getUserID() {
  let userId = localStorage.getItem("user_id");
  if (userId) return userId;
  userId = crypto.randomUUID();
  localStorage.setItem("user_id", userId);
  return userId;
}

export const EXAMPLE_CODE = `# Here is some example code

# Slow version
def fibonacci(i):
  if i == 0 or i == 1:
    return 1
  
  return fibonacci(i-1) + fibonacci(i-2)
    

# Faster version
def fibonacci(n):
  fibs = []
  for i in range(n):
    if i <= 1:
      fibs.append(1)
      continue
    fibs.append(fibs[i-1]+fibs[i-2])
  return fibs[-1]
`;
