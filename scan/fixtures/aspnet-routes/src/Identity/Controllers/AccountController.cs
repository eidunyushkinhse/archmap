public class AccountController : Controller
{
    [HttpGet]
    public IActionResult Login(string returnUrl) => View();

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> LogoutAsync(LogoutInputModel model) => View();

    public IActionResult Helper() => View();
}
