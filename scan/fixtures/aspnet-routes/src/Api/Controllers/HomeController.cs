namespace Api.Controllers;

// Без [ApiController] и без [Route] у класса: маршруты на методах.
public class HomeController : Controller
{
    [Route("")]
    [Route("home")]
    public IActionResult Index() => View();

    [Route("about")]
    [HttpGet]
    public IActionResult About() => View();

    [HttpGet("/privacy")]
    public IActionResult Privacy() => View();

    // Маршрут по соглашению: шаблон задаёт MapControllerRoute.
    [HttpPost]
    public IActionResult Feedback(string text) => View();
}

public class NotAController
{
    [HttpGet("ignored")]
    public void Run() { }
}
